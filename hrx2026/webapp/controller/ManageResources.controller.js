sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/core/Fragment",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/m/MessageToast",
	"sap/m/MessageBox",
	"../model/Backend",
	"../model/CurrentUser",
	"../model/formatter"
], function (Controller, Fragment, JSONModel, Filter, FilterOperator, MessageToast, MessageBox, Backend, CurrentUser, formatter) {
	"use strict";

	// Root path of the backend services. Both the local dev proxy (ui5.yaml) and the
	// deployed approuter (xs-app.json) expose the HANA XS services below /services.
	var SERVICE_ROOT = Backend.SERVICE_ROOT;

	var USERS_SERVICE = SERVICE_ROOT + "/master/manageUsers.xsjs";
	var LEAVE_SERVICE = SERVICE_ROOT + "/hrx/leaveReqs.xsjs";

	// Everything except Pic/PicB - the pictures are base64 blobs of several hundred KB
	// each and are only needed once a single resource is opened.
	var LIST_FIELDS = [
		"ID", "UserID", "EmpID", "OrgID", "FName", "LName", "Email", "Mobile",
		"UserTypeKey", "BaseSiteKey", "ManagerID", "IsActive", "TargetUtilization",
		"TargetHrsPerWeek", "AnnualLeaveQuota", "BonusPercent", "PensionRate",
		"Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"
	];

	var DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

	var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

	return Controller.extend("bsx.hrx.hrx2026.controller.ManageResources", {

		formatter: formatter,

		/* =========================================================== */
		/* lifecycle                                                   */
		/* =========================================================== */

		onInit: function () {
			this._sOrgId = this._resolveOrgId();

			this.setModel(new JSONModel({
				layout: "OneColumn",
				fullScreen: false,
				listBusy: true,
				detailBusy: false,
				leaveBusy: false,
				saving: false,
				title: this.getText("mrListTitle"),
				searchQuery: "",
				selectedId: null,
				selectedTab: "info",
				filter: this._defaultFilter(),
				filterDraft: this._defaultFilter()
			}), "mrView");

			this.setModel(new JSONModel({
				allResources: [],
				resources: [],
				managers: [],
				sites: [],
				userTypes: []
			}), "mr");

			this.setModel(new JSONModel({}), "mrDetail");
			this.setModel(new JSONModel(this._emptyLeaveData()), "mrLeave");
			this.setModel(new JSONModel(this._emptyNewResource()), "mrNew");

			// The value helps never change, so they are fetched once. The resource list is
			// (re)loaded per entry into the app, see _onRouteMatched.
			this._pLookupsLoaded = this._loadLookups();

			this.getOwnerComponent().getRouter().getRoute("resources")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		/**
		 * The view is instantiated once and then reused, so entering the app has to reset
		 * it explicitly: the user always lands on the resource list rather than on the
		 * resource they happened to have open the last time.
		 */
		_onRouteMatched: function () {
			this._resetToList();
			this._pLookupsLoaded.then(this._loadResources.bind(this));
		},

		/**
		 * Returns the view to its initial state: list only, nothing selected, no search
		 * term and the default filters.
		 */
		_resetToList: function () {
			var oViewModel = this.getModel("mrView");

			oViewModel.setProperty("/searchQuery", "");
			oViewModel.setProperty("/filter", this._defaultFilter());
			oViewModel.setProperty("/filterDraft", this._defaultFilter());

			this._closeDetail();
		},

		/* =========================================================== */
		/* data loading                                                */
		/* =========================================================== */

		/**
		 * Loads the sites and user type value helps from the OData service.
		 * @returns {Promise} resolved once both value helps are in the model
		 */
		_loadLookups: function () {
			var oModel = this.getModel("mr");

			var pSites = this._read("/sites", {
				filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)]
			}).then(function (oData) {
				var aSites = (oData.results || [])
					.filter(function (oSite) {
						return !!oSite.SiteID;
					})
					.map(function (oSite) {
						return {
							SiteID: oSite.SiteID,
							SiteLabel: oSite.SiteDesc || oSite.SiteLocation || oSite.SiteID,
							SiteLocation: oSite.SiteLocation || ""
						};
					})
					.sort(function (a, b) {
						return a.SiteLabel.localeCompare(b.SiteLabel);
					});

				this._mSiteNames = aSites.reduce(function (mNames, oSite) {
					mNames[oSite.SiteID] = oSite.SiteLabel;
					return mNames;
				}, {});

				oModel.setProperty("/sites", aSites);
			}.bind(this));

			var pUserTypes = this._read("/UserTypes", {
				filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)]
			}).then(function (oData) {
				oModel.setProperty("/userTypes", (oData.results || []).map(function (oType) {
					return {
						UserTypeKey: oType.UserTypeKey,
						UserTypeDesc: oType.UserTypeDesc
					};
				}).sort(function (a, b) {
					return a.UserTypeDesc.localeCompare(b.UserTypeDesc);
				}));
			});

			return Promise.all([pSites, pUserTypes]).catch(function (oError) {
				this._showError("mrErrorLookups", oError);
			}.bind(this));
		},

		/**
		 * Reads every resource of the organisation and applies the current list filters.
		 * @returns {Promise} resolved once the list is filled
		 */
		_loadResources: function () {
			var oViewModel = this.getModel("mrView");
			oViewModel.setProperty("/listBusy", true);

			return this._read("/Resources", {
				urlParameters: { "$select": LIST_FIELDS.join(",") },
				filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)]
			}).then(function (oData) {
				var aResources = (oData.results || []).map(this._decorateResource, this);
				var oModel = this.getModel("mr");

				oModel.setProperty("/allResources", aResources);
				oModel.setProperty("/managers", aResources.filter(function (oResource) {
					return oResource.IsActive === "Y";
				}).sort(this._byName));

				this._applyListFilters();
				oViewModel.setProperty("/listBusy", false);
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/listBusy", false);
				this._showError("mrErrorResources", oError);
			}.bind(this));
		},

		/**
		 * Adds the display-only fields the list needs on top of the raw entity.
		 * @param {object} oResource resource entity as returned by the service
		 * @returns {object} the enriched resource
		 */
		_decorateResource: function (oResource) {
			var oCopy = Object.assign({}, oResource);
			delete oCopy.__metadata;
			oCopy.SiteName = this._siteName(oCopy.BaseSiteKey);
			oCopy.FullName = ((oCopy.FName || "") + " " + (oCopy.LName || "")).trim();
			return oCopy;
		},

		_siteName: function (sSiteKey) {
			return (this._mSiteNames && this._mSiteNames[sSiteKey]) || sSiteKey || "";
		},

		_byName: function (a, b) {
			return (a.FullName || "").localeCompare(b.FullName || "");
		},

		/**
		 * Applies search term, user type, active state and site filters on the resource
		 * list and refreshes the list header count.
		 */
		_applyListFilters: function () {
			var oViewModel = this.getModel("mrView");
			var oFilter = oViewModel.getProperty("/filter");
			var sQuery = (oViewModel.getProperty("/searchQuery") || "").trim().toLowerCase();

			var aFiltered = (this.getModel("mr").getProperty("/allResources") || []).filter(function (oResource) {
				if (oFilter.userType !== "A" && oResource.UserTypeKey !== oFilter.userType) {
					return false;
				}
				if (oFilter.active !== "A" && (oResource.IsActive || "N") !== oFilter.active) {
					return false;
				}
				if (oFilter.site && oResource.BaseSiteKey !== oFilter.site) {
					return false;
				}
				if (sQuery) {
					var sHaystack = [
						oResource.FullName, oResource.Email, oResource.SiteName, oResource.Mobile
					].join(" ").toLowerCase();
					if (sHaystack.indexOf(sQuery) === -1) {
						return false;
					}
				}
				return true;
			}).sort(this._byName);

			this.getModel("mr").setProperty("/resources", aFiltered);
			oViewModel.setProperty("/title", this.getText("mrListTitleCount", [aFiltered.length]));
		},

		/**
		 * Reads the complete resource (including the picture) and shows it in the detail column.
		 * @param {string} sEmpId the EmpID of the resource
		 */
		_showResource: function (sEmpId) {
			var oViewModel = this.getModel("mrView");
			var oModel = this.getOwnerComponent().getModel();

			oViewModel.setProperty("/selectedId", sEmpId);
			oViewModel.setProperty("/selectedTab", "info");
			oViewModel.setProperty("/layout", oViewModel.getProperty("/fullScreen") ? "MidColumnFullScreen" : "TwoColumnsMidExpanded");
			oViewModel.setProperty("/detailBusy", true);
			this.getModel("mrLeave").setData(this._emptyLeaveData());

			return oModel.metadataLoaded().then(function () {
				return this._read("/" + oModel.createKey("Resources", { EmpID: sEmpId }));
			}.bind(this)).then(function (oResource) {
				this.getModel("mrDetail").setData(this._toDetail(oResource));
				oViewModel.setProperty("/detailBusy", false);
				this._resetPictureUploader();
				this._loadLeaves(oResource.Email);
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/detailBusy", false);
				this._closeDetail();
				this._showError("mrErrorResourceDetail", oError);
			}.bind(this));
		},

		/**
		 * Turns the raw entity into the editable shape the detail form is bound against.
		 * @param {object} oResource the resource entity
		 * @returns {object} the editable detail object
		 */
		_toDetail: function (oResource) {
			var oDetail = {
				ID: oResource.ID,
				UserID: oResource.UserID,
				EmpID: oResource.EmpID,
				OrgID: oResource.OrgID || this._sOrgId,
				FName: oResource.FName || "",
				LName: oResource.LName || "",
				Email: oResource.Email || "",
				Mobile: oResource.Mobile || "",
				UserTypeKey: oResource.UserTypeKey || "",
				BaseSiteKey: oResource.BaseSiteKey || "",
				ManagerID: oResource.ManagerID || "",
				Pic: oResource.Pic || "",
				PicB: oResource.PicB || "",
				NewPic: "",
				IsActive: oResource.IsActive || "N",
				Active: oResource.IsActive === "Y",
				TargetUtilization: this._toNumber(oResource.TargetUtilization),
				TargetHrsPerWeek: oResource.TargetHrsPerWeek || "",
				AnnualLeaveQuota: this._toNumber(oResource.AnnualLeaveQuota),
				BonusPercent: this._toNumber(oResource.BonusPercent),
				PensionRate: this._toNumber(oResource.PensionRate),
				SiteName: this._siteName(oResource.BaseSiteKey),
				FullName: ((oResource.FName || "") + " " + (oResource.LName || "")).trim(),
				days: {}
			};

			DAYS.forEach(function (sDay) {
				oDetail.days[sDay] = oResource[sDay] === "Y";
			});

			return oDetail;
		},

		/**
		 * Fetches quota, taken days and the individual leave records of a resource.
		 * @param {string} sEmail the resource's email - the key used by leaveReqs.xsjs
		 */
		_loadLeaves: function (sEmail) {
			var oViewModel = this.getModel("mrView");

			if (!sEmail) {
				this.getModel("mrLeave").setData(this._emptyLeaveData());
				return Promise.resolve();
			}

			oViewModel.setProperty("/leaveBusy", true);

			return this._getJson(LEAVE_SERVICE + "?cmd=fetchUser&" + new URLSearchParams({
				Email: sEmail,
				OrgID: this._sOrgId
			}).toString()).then(function (oData) {
				this.getModel("mrLeave").setData({
					loaded: true,
					user: oData.user || {},
					availedLeaves: oData.availedLeaves || [],
					bankHolidays: oData.bankHolidays || [],
					analyticsData: oData.analyticsData || []
				});
				oViewModel.setProperty("/leaveBusy", false);
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/leaveBusy", false);
				this.getModel("mrLeave").setData(this._emptyLeaveData());
				MessageToast.show(this.getText("mrErrorLeaves") + " " + this._errorText(oError));
			}.bind(this));
		},

		/* =========================================================== */
		/* list events                                                 */
		/* =========================================================== */

		onSearch: function () {
			this._applyListFilters();
		},

		onRefresh: function () {
			var sSelectedId = this.getModel("mrView").getProperty("/selectedId");
			this._loadResources().then(function () {
				if (sSelectedId) {
					this._showResource(sSelectedId);
				}
			}.bind(this));
		},

		onResourcePress: function (oEvent) {
			var oContext = oEvent.getSource().getBindingContext("mr");
			if (oContext) {
				this._showResource(oContext.getProperty("EmpID"));
			}
		},

		onResourceSelect: function (oEvent) {
			var oItem = oEvent.getParameter("listItem");
			var oContext = oItem && oItem.getBindingContext("mr");
			if (oContext) {
				this._showResource(oContext.getProperty("EmpID"));
			}
		},

		/* =========================================================== */
		/* detail events                                               */
		/* =========================================================== */

		onCloseDetail: function () {
			this._closeDetail();
		},

		_closeDetail: function () {
			var oViewModel = this.getModel("mrView");
			oViewModel.setProperty("/layout", "OneColumn");
			oViewModel.setProperty("/fullScreen", false);
			oViewModel.setProperty("/selectedId", null);
			oViewModel.setProperty("/selectedTab", "info");
			this.getModel("mrDetail").setData({});
			this.getModel("mrLeave").setData(this._emptyLeaveData());
		},

		onToggleFullScreen: function () {
			var oViewModel = this.getModel("mrView");
			var bFullScreen = !oViewModel.getProperty("/fullScreen");
			oViewModel.setProperty("/fullScreen", bFullScreen);
			oViewModel.setProperty("/layout", bFullScreen ? "MidColumnFullScreen" : "TwoColumnsMidExpanded");
		},

		onPictureChange: function (oEvent) {
			var aFiles = oEvent.getParameter("files");
			var oFile = aFiles && aFiles[0];
			if (!oFile) {
				return;
			}

			var oDetailModel = this.getModel("mrDetail");
			var oReader = new FileReader();
			oReader.onload = function (oLoadEvent) {
				oDetailModel.setProperty("/NewPic", oLoadEvent.target.result);
			};
			oReader.readAsDataURL(oFile);
		},

		onPictureTypeMismatch: function (oEvent) {
			MessageToast.show(this.getText("mrErrorFileType", [oEvent.getParameter("fileType")]));
		},

		onRemovePicture: function () {
			this.getModel("mrDetail").setProperty("/NewPic", "");
			this.getModel("mrDetail").setProperty("/Pic", "");
			this._resetPictureUploader();
		},

		_resetPictureUploader: function () {
			var oUploader = this.byId("resourcePictureUploader");
			if (oUploader) {
				oUploader.setValue("");
			}
		},

		/**
		 * Persists the edited resource through manageUsers.xsjs.
		 */
		onSave: function () {
			var oDetail = this.getModel("mrDetail").getData();

			if (!oDetail.EmpID) {
				return;
			}
			// Last name is not enforced here: existing records legitimately carry a single
			// name, and blocking them would make those resources uneditable.
			if (!oDetail.FName || !oDetail.BaseSiteKey || !oDetail.UserTypeKey) {
				MessageBox.error(this.getText("mrErrorDetailIncomplete"));
				return;
			}

			var oPayload = {
				ID: oDetail.ID,
				UserID: oDetail.UserID,
				EmpID: oDetail.EmpID,
				OrgID: oDetail.OrgID,
				BaseSiteKey: oDetail.BaseSiteKey,
				FName: oDetail.FName,
				LName: oDetail.LName,
				ManagerID: oDetail.ManagerID || "",
				Mobile: oDetail.Mobile || "",
				Email: oDetail.Email,
				Pic: oDetail.NewPic || oDetail.Pic || "",
				PicB: oDetail.PicB || "",
				IsActive: oDetail.Active ? "Y" : "N",
				UserTypeKey: oDetail.UserTypeKey,
				HostID: "",
				VehRegNo: "",
				AnnualLeaveQuota: String(oDetail.AnnualLeaveQuota || 0),
				TargetUtilization: String(oDetail.TargetUtilization || 0),
				TargetHrsPerWeek: oDetail.TargetHrsPerWeek || "",
				BonusPercent: this._toNumber(oDetail.BonusPercent),
				PensionRate: this._toNumber(oDetail.PensionRate)
			};

			DAYS.forEach(function (sDay) {
				oPayload[sDay] = oDetail.days[sDay] ? "Y" : "N";
			});

			this.getModel("mrView").setProperty("/saving", true);

			this._postJson(USERS_SERVICE + "?cmd=update&visitorx=", oPayload).then(function (oResult) {
				this.getModel("mrView").setProperty("/saving", false);
				MessageToast.show(oResult.msg || this.getText("mrSaved"));
				return this._loadResources().then(function () {
					return this._showResource(oDetail.EmpID);
				}.bind(this));
			}.bind(this)).catch(function (oError) {
				this.getModel("mrView").setProperty("/saving", false);
				this._showError("mrErrorSave", oError);
			}.bind(this));
		},

		/**
		 * Flags the selected resource as deleted through manageUsers.xsjs.
		 */
		onDelete: function () {
			var oDetail = this.getModel("mrDetail").getData();
			if (!oDetail.EmpID) {
				return;
			}

			MessageBox.confirm(this.getText("mrConfirmDelete", [oDetail.FullName]), {
				title: this.getText("mrConfirmDeleteTitle"),
				icon: MessageBox.Icon.WARNING,
				emphasizedAction: MessageBox.Action.CANCEL,
				onClose: function (sAction) {
					if (sAction !== MessageBox.Action.OK) {
						return;
					}

					this.getModel("mrView").setProperty("/saving", true);

					this._postJson(USERS_SERVICE + "?cmd=delete", {
						EmpID: oDetail.UserID,
						UserTypeKey: oDetail.UserTypeKey,
						IsDeleted: "Y"
					}).then(function (oResult) {
						this.getModel("mrView").setProperty("/saving", false);
						MessageToast.show(oResult.msg || this.getText("mrDeleted"));
						this._closeDetail();
						return this._loadResources();
					}.bind(this)).catch(function (oError) {
						this.getModel("mrView").setProperty("/saving", false);
						this._showError("mrErrorDelete", oError);
					}.bind(this));
				}.bind(this)
			});
		},

		/* =========================================================== */
		/* filter dialog                                               */
		/* =========================================================== */

		onOpenFilter: function () {
			var oViewModel = this.getModel("mrView");
			oViewModel.setProperty("/filterDraft", Object.assign({}, oViewModel.getProperty("/filter")));

			this._openDialog("_pFilterDialog", "bsx.hrx.hrx2026.fragment.ResourceFilterDialog");
		},

		onConfirmFilter: function () {
			var oViewModel = this.getModel("mrView");
			oViewModel.setProperty("/filter", Object.assign({}, oViewModel.getProperty("/filterDraft")));
			this._applyListFilters();
			this._closeDialog("_pFilterDialog");
		},

		onCancelFilter: function () {
			this._closeDialog("_pFilterDialog");
		},

		onClearFilter: function () {
			this.getModel("mrView").setProperty("/filterDraft", { userType: "A", active: "A", site: "" });
		},

		/* =========================================================== */
		/* add resource dialog                                         */
		/* =========================================================== */

		onOpenAddResource: function () {
			this.getModel("mrNew").setData(this._emptyNewResource());
			this._openDialog("_pAddDialog", "bsx.hrx.hrx2026.fragment.AddResourceDialog").then(function () {
				["newFirstName", "newLastName", "newEmail", "newSite", "newUserType"].forEach(function (sId) {
					var oControl = this.byId(sId);
					if (oControl) {
						oControl.setValueState("None");
					}
				}, this);
			}.bind(this));
		},

		onCancelAddResource: function () {
			this._closeDialog("_pAddDialog");
		},

		/**
		 * Validates a single field of the "new resource" dialog while typing.
		 * @param {sap.ui.base.Event} oEvent the liveChange/change event
		 */
		onNewResourceFieldChange: function (oEvent) {
			var oControl = oEvent.getSource();
			var sValue = oControl.getValue ? oControl.getValue() : "";

			if (oControl === this.byId("newEmail")) {
				this._validateEmailControl(oControl);
				return;
			}
			if (oControl === this.byId("newMobile")) {
				oControl.setValueState("None");
				return;
			}

			oControl.setValueState(sValue ? "None" : "Error");
			oControl.setValueStateText(this.getText("mrMandatory"));
		},

		onNewResourceSelectionChange: function (oEvent) {
			var oControl = oEvent.getSource();
			var bValid = !!oControl.getSelectedKey();
			oControl.setValueState(bValid ? "None" : "Error");
			oControl.setValueStateText(this.getText("mrMandatory"));
		},

		/**
		 * Creates the new resource through manageUsers.xsjs.
		 */
		onCreateResource: function () {
			if (!this._validateNewResource()) {
				return;
			}

			var oNew = this.getModel("mrNew").getData();
			var oPayload = {
				UserID: "",
				EmpID: "",
				OrgID: this._sOrgId,
				BaseSiteKey: oNew.BaseSiteKey,
				FName: oNew.FName.trim(),
				LName: oNew.LName.trim(),
				ManagerID: "",
				Mobile: oNew.Mobile || "",
				Email: oNew.Email.trim(),
				Pic: "",
				PicB: "",
				IsActive: "Y",
				Organization: "",
				IsPreReg: "N",
				UserTypeKey: oNew.UserTypeKey,
				HostID: "",
				VehRegNo: "",
				AccessCard: "",
				VisitingOn: "",
				VisitingAt: "",
				IsDeleted: "N",
				TargetUtilization: "",
				TargetHrsPerWeek: ""
			};

			this.getModel("mrView").setProperty("/saving", true);

			this._postJson(USERS_SERVICE + "?cmd=new", oPayload).then(function (oResult) {
				this.getModel("mrView").setProperty("/saving", false);
				MessageToast.show(oResult.msg || this.getText("mrCreated"));
				this._closeDialog("_pAddDialog");
				return this._loadResources();
			}.bind(this)).catch(function (oError) {
				this.getModel("mrView").setProperty("/saving", false);
				this._showError("mrErrorCreate", oError);
			}.bind(this));
		},

		/**
		 * @returns {boolean} true when every mandatory field of the add dialog is filled
		 */
		_validateNewResource: function () {
			var bValid = true;

			[
				{ id: "newFirstName", path: "/FName" },
				{ id: "newLastName", path: "/LName" }
			].forEach(function (oField) {
				var oControl = this.byId(oField.id);
				var bFilled = !!(this.getModel("mrNew").getProperty(oField.path) || "").trim();
				oControl.setValueState(bFilled ? "None" : "Error");
				oControl.setValueStateText(this.getText("mrMandatory"));
				bValid = bValid && bFilled;
			}, this);

			bValid = this._validateEmailControl(this.byId("newEmail")) && bValid;

			["newSite", "newUserType"].forEach(function (sId) {
				var oControl = this.byId(sId);
				var bFilled = !!oControl.getSelectedKey();
				oControl.setValueState(bFilled ? "None" : "Error");
				oControl.setValueStateText(this.getText("mrMandatory"));
				bValid = bValid && bFilled;
			}, this);

			return bValid;
		},

		_validateEmailControl: function (oControl) {
			var sValue = (oControl.getValue() || "").trim();

			if (!sValue) {
				oControl.setValueState("Error");
				oControl.setValueStateText(this.getText("mrMandatory"));
				return false;
			}
			if (!EMAIL_PATTERN.test(sValue)) {
				oControl.setValueState("Error");
				oControl.setValueStateText(this.getText("mrInvalidEmail"));
				return false;
			}

			oControl.setValueState("None");
			return true;
		},

		/* =========================================================== */
		/* helpers                                                     */
		/* =========================================================== */

		getModel: function (sName) {
			return this.getView().getModel(sName);
		},

		setModel: function (oModel, sName) {
			this.getView().setModel(oModel, sName);
			return this;
		},

		getResourceBundle: function () {
			return this.getOwnerComponent().getModel("i18n").getResourceBundle();
		},

		getText: function (sKey, aArgs) {
			return this.getResourceBundle().getText(sKey, aArgs);
		},

		/**
		 * Reads from the OData service and wraps the callback API in a promise.
		 * @param {string} sPath the entity set or entity path
		 * @param {object} [mParameters] additional read parameters (filters, urlParameters, ...)
		 * @returns {Promise<object>} the response data
		 */
		_read: function (sPath, mParameters) {
			// Backend.read, not a bare model.read: it waits for the service metadata,
			// including the retries Component.js makes after a failed first attempt, so
			// a momentary outage at startup no longer leaves every value help on the
			// page empty for the rest of the session.
			return Backend.read(this.getOwnerComponent().getModel(), sPath, mParameters);
		},

		_getJson: function (sUrl) {
			return this._request(sUrl, { method: "GET" });
		},

		_postJson: function (sUrl, oPayload) {
			return this._request(sUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(oPayload)
			});
		},

		/**
		 * Calls one of the XS JavaScript services and normalises its error handling:
		 * these services answer with HTTP 200 and a msgType of "S" on success.
		 * @param {string} sUrl the service url
		 * @param {object} oInit fetch options
		 * @returns {Promise<object>} the parsed response
		 */
		_request: function (sUrl, oInit) {
			return fetch(sUrl, oInit).then(function (oResponse) {
				return oResponse.text().then(function (sBody) {
					var oJson = null;
					try {
						oJson = sBody ? JSON.parse(sBody) : null;
					} catch (oParseError) {
						oJson = null;
					}

					if (!oResponse.ok || !oJson || oJson.msgType !== "S") {
						var sMessage = (oJson && (oJson.msg || oJson.message)) || sBody || oResponse.statusText;
						throw new Error(sMessage);
					}

					return oJson;
				});
			});
		},

		_openDialog: function (sCacheKey, sFragmentName) {
			if (!this[sCacheKey]) {
				this[sCacheKey] = Fragment.load({
					id: this.getView().getId(),
					name: sFragmentName,
					controller: this
				}).then(function (oDialog) {
					this.getView().addDependent(oDialog);
					return oDialog;
				}.bind(this));
			}

			return this[sCacheKey].then(function (oDialog) {
				oDialog.open();
				return oDialog;
			});
		},

		_closeDialog: function (sCacheKey) {
			if (this[sCacheKey]) {
				this[sCacheKey].then(function (oDialog) {
					oDialog.close();
				});
			}
		},

		_resolveOrgId: function () {
			return CurrentUser.orgId(this.getOwnerComponent());
		},

		_defaultFilter: function () {
			return { userType: "S", active: "Y", site: "" };
		},

		_emptyNewResource: function () {
			return {
				FName: "",
				LName: "",
				Email: "",
				Mobile: "",
				BaseSiteKey: "",
				UserTypeKey: "S"
			};
		},

		_emptyLeaveData: function () {
			return {
				loaded: false,
				user: {},
				availedLeaves: [],
				bankHolidays: [],
				analyticsData: []
			};
		},

		_toNumber: function (vValue) {
			var fValue = parseFloat(vValue);
			return isNaN(fValue) ? 0 : fValue;
		},

		_errorText: function (oError) {
			if (!oError) {
				return "";
			}
			if (oError.message) {
				return oError.message;
			}
			if (oError.responseText) {
				try {
					var oBody = JSON.parse(oError.responseText);
					return oBody.msg || oBody.error && oBody.error.message && oBody.error.message.value || oError.responseText;
				} catch (oParseError) {
					return oError.responseText;
				}
			}
			return String(oError);
		},

		_showError: function (sTextKey, oError) {
			MessageBox.error(this.getText(sTextKey), {
				details: this._errorText(oError)
			});
		}
	});
});
