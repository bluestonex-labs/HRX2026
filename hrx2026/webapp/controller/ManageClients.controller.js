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

	// Root path of the backend services - see xs-app.json (deployed) and ui5.yaml (local).
	var SERVICE_ROOT = Backend.SERVICE_ROOT;

	var CLIENTS_SERVICE = SERVICE_ROOT + "/hrx/manageClients.xsjs";
	var CLIENT_APPS_SERVICE = SERVICE_ROOT + "/hrx/manageClientApps.xsjs";
	var CLIENT_USERS_SERVICE = SERVICE_ROOT + "/supportx/ManageClientUsers.xsjs";
	var SLA_SERVICE = SERVICE_ROOT + "/supportx/ManageSLA.xsjs";

	var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

	return Controller.extend("bsx.hrx.hrx2026.controller.ManageClients", {

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
				tabBusy: false,
				saving: false,
				title: this.getText("mcListTitle"),
				searchQuery: "",
				selectedId: null,
				selectedTab: "basic"
			}), "mcView");

			this.setModel(new JSONModel({
				allClients: [],
				clients: [],
				priorities: [],
				softwares: [],
				components: [],
				subComponents: [],
				apps: [],
				services: []
			}), "mc");

			this.setModel(new JSONModel({}), "mcDetail");
			this.setModel(new JSONModel(this._emptyTabs()), "mcTabs");
			this.setModel(new JSONModel({}), "mcForm");

			this._pLookupsLoaded = this._loadLookups();

			this.getOwnerComponent().getRouter().getRoute("clients")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		/**
		 * The view is reused across navigations, so entering the app always returns to
		 * the client list rather than to whatever was open before.
		 */
		_onRouteMatched: function () {
			this.getModel("mcView").setProperty("/searchQuery", "");
			this._closeDetail();
			this._pLookupsLoaded.then(this._loadClients.bind(this));
		},

		/* =========================================================== */
		/* data loading                                                */
		/* =========================================================== */

		/**
		 * Loads every value help the detail tabs need: severities, software catalogue and
		 * the BTP app/service catalogue.
		 * @returns {Promise} resolved once the lookups are in the model
		 */
		_loadLookups: function () {
			var oModel = this.getModel("mc");

			return Promise.all([
				this._read("/PRIORITY"),
				this._read("/Softwares"),
				this._read("/Components"),
				this._read("/SubComponents"),
				this._read("/AppMaster"),
				this._read("/BTPServices")
			]).then(function (aResults) {
				oModel.setProperty("/priorities", this._strip(aResults[0]));
				oModel.setProperty("/softwares", this._strip(aResults[1]));
				oModel.setProperty("/components", this._strip(aResults[2]));
				oModel.setProperty("/subComponents", this._strip(aResults[3]));
				oModel.setProperty("/apps", this._strip(aResults[4]));
				oModel.setProperty("/services", this._strip(aResults[5]));
			}.bind(this)).catch(function (oError) {
				this._showError("mcErrorLookups", oError);
			}.bind(this));
		},

		/**
		 * Reads every client of the organisation.
		 * @returns {Promise} resolved once the list is filled
		 */
		_loadClients: function () {
			var oViewModel = this.getModel("mcView");
			oViewModel.setProperty("/listBusy", true);

			return this._read("/Clients", {
				filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)]
			}).then(function (oData) {
				this.getModel("mc").setProperty("/allClients", this._strip(oData));
				this._applyListFilters();
				oViewModel.setProperty("/listBusy", false);
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/listBusy", false);
				this._showError("mcErrorClients", oError);
			}.bind(this));
		},

		_applyListFilters: function () {
			var oViewModel = this.getModel("mcView");
			var sQuery = (oViewModel.getProperty("/searchQuery") || "").trim().toLowerCase();

			var aFiltered = (this.getModel("mc").getProperty("/allClients") || []).filter(function (oClient) {
				if (!sQuery) {
					return true;
				}
				return [oClient.ClientDesc, oClient.ClientLocation, oClient.ClientKey, oClient.ClientContactName]
					.join(" ").toLowerCase().indexOf(sQuery) !== -1;
			}).sort(function (a, b) {
				return (a.ClientDesc || "").localeCompare(b.ClientDesc || "");
			});

			this.getModel("mc").setProperty("/clients", aFiltered);
			oViewModel.setProperty("/title", this.getText("mcListTitleCount", [aFiltered.length]));
		},

		/**
		 * Opens a client in the detail column and loads the data of the active tab.
		 * @param {string} sClientKey the client key
		 * @returns {Promise} resolved once the client is shown
		 */
		_showClient: function (sClientKey) {
			var oViewModel = this.getModel("mcView");
			var oModel = this.getOwnerComponent().getModel();

			oViewModel.setProperty("/selectedId", sClientKey);
			oViewModel.setProperty("/selectedTab", "basic");
			oViewModel.setProperty("/layout", oViewModel.getProperty("/fullScreen") ? "MidColumnFullScreen" : "TwoColumnsMidExpanded");
			oViewModel.setProperty("/detailBusy", true);
			this.getModel("mcTabs").setData(this._emptyTabs());

			return oModel.metadataLoaded().then(function () {
				return this._read("/" + oModel.createKey("Clients", {
					OrgID: this._sOrgId,
					ClientKey: sClientKey
				}));
			}.bind(this)).then(function (oClient) {
				this.getModel("mcDetail").setData(this._toDetail(oClient));
				oViewModel.setProperty("/detailBusy", false);
				this._resetLogoUploader();
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/detailBusy", false);
				this._closeDetail();
				this._showError("mcErrorClientDetail", oError);
			}.bind(this));
		},

		_toDetail: function (oClient) {
			return {
				OrgID: oClient.OrgID || this._sOrgId,
				ClientKey: oClient.ClientKey,
				ClientDesc: oClient.ClientDesc || "",
				ClientLocation: oClient.ClientLocation || "",
				ClientLogo: oClient.ClientLogo || "",
				NewLogo: "",
				ClientContactName: oClient.ClientContactName || "",
				ClientContactEmail: oClient.ClientContactEmail || "",
				ClientContactMobile: oClient.ClientContactMobile || ""
			};
		},

		/* =========================================================== */
		/* tabs                                                        */
		/* =========================================================== */

		onTabSelect: function (oEvent) {
			this._loadTab(oEvent.getParameter("key"));
		},

		/**
		 * Each detail tab is fed by its own service, so the data is fetched when the tab
		 * is opened rather than all at once.
		 * @param {string} sKey the tab key
		 * @returns {Promise} resolved once the tab data is loaded
		 */
		_loadTab: function (sKey) {
			var sClientKey = this.getModel("mcView").getProperty("/selectedId");
			if (!sClientKey) {
				return Promise.resolve();
			}

			switch (sKey) {
				case "team":
					return this._loadUsers(sClientKey);
				case "sla":
					return this._loadSla(sClientKey);
				case "components":
					return this._loadComponents(sClientKey);
				case "services":
					return this._loadServices(sClientKey);
				default:
					return Promise.resolve();
			}
		},

		_reloadCurrentTab: function () {
			return this._loadTab(this.getModel("mcView").getProperty("/selectedTab"));
		},

		_loadUsers: function (sClientKey) {
			return this._withTabBusy(this._getJson(CLIENT_USERS_SERVICE + "?cmd=fetch&" + new URLSearchParams({
				OrgID: sClientKey
			}).toString()).then(function (oData) {
				this.getModel("mcTabs").setProperty("/users", oData.users || []);
			}.bind(this)), "mcErrorUsers");
		},

		_loadSla: function (sClientKey) {
			return this._withTabBusy(this._getJson(SLA_SERVICE + "?cmd=fetch&" + new URLSearchParams({
				OrgID: sClientKey
			}).toString()).then(function (oData) {
				this.getModel("mcTabs").setProperty("/sla", oData.sla || []);
			}.bind(this)), "mcErrorSla");
		},

		_loadComponents: function (sClientKey) {
			return this._withTabBusy(this._read("/LicensedAppsData", {
				filters: [new Filter("ClientKey", FilterOperator.EQ, sClientKey)]
			}).then(function (oData) {
				this.getModel("mcTabs").setProperty("/components", this._strip(oData));
			}.bind(this)), "mcErrorComponents");
		},

		_loadServices: function (sClientKey) {
			return this._withTabBusy(this._read("/ClientAppServiceView", {
				filters: [new Filter("ClientKey", FilterOperator.EQ, sClientKey)]
			}).then(function (oData) {
				this.getModel("mcTabs").setProperty("/services", this._strip(oData));
			}.bind(this)), "mcErrorServices");
		},

		_withTabBusy: function (pWork, sErrorKey) {
			var oViewModel = this.getModel("mcView");
			oViewModel.setProperty("/tabBusy", true);

			return pWork.then(function () {
				oViewModel.setProperty("/tabBusy", false);
			}).catch(function (oError) {
				oViewModel.setProperty("/tabBusy", false);
				this._showError(sErrorKey, oError);
			}.bind(this));
		},

		/* =========================================================== */
		/* list events                                                 */
		/* =========================================================== */

		onSearch: function () {
			this._applyListFilters();
		},

		onRefresh: function () {
			var sSelectedId = this.getModel("mcView").getProperty("/selectedId");
			this._loadClients().then(function () {
				if (sSelectedId) {
					this._showClient(sSelectedId);
				}
			}.bind(this));
		},

		onClientPress: function (oEvent) {
			var oContext = oEvent.getSource().getBindingContext("mc");
			if (oContext) {
				this._showClient(oContext.getProperty("ClientKey"));
			}
		},

		onClientSelect: function (oEvent) {
			var oItem = oEvent.getParameter("listItem");
			var oContext = oItem && oItem.getBindingContext("mc");
			if (oContext) {
				this._showClient(oContext.getProperty("ClientKey"));
			}
		},

		onCloseDetail: function () {
			this._closeDetail();
		},

		_closeDetail: function () {
			var oViewModel = this.getModel("mcView");
			oViewModel.setProperty("/layout", "OneColumn");
			oViewModel.setProperty("/fullScreen", false);
			oViewModel.setProperty("/selectedId", null);
			oViewModel.setProperty("/selectedTab", "basic");
			this.getModel("mcDetail").setData({});
			this.getModel("mcTabs").setData(this._emptyTabs());
		},

		onToggleFullScreen: function () {
			var oViewModel = this.getModel("mcView");
			var bFullScreen = !oViewModel.getProperty("/fullScreen");
			oViewModel.setProperty("/fullScreen", bFullScreen);
			oViewModel.setProperty("/layout", bFullScreen ? "MidColumnFullScreen" : "TwoColumnsMidExpanded");
		},

		/* =========================================================== */
		/* basic info                                                  */
		/* =========================================================== */

		onLogoChange: function (oEvent) {
			var aFiles = oEvent.getParameter("files");
			var oFile = aFiles && aFiles[0];
			if (!oFile) {
				return;
			}

			var oDetailModel = this.getModel("mcDetail");
			var oReader = new FileReader();
			oReader.onload = function (oLoadEvent) {
				oDetailModel.setProperty("/NewLogo", oLoadEvent.target.result);
			};
			oReader.readAsDataURL(oFile);
		},

		onLogoTypeMismatch: function (oEvent) {
			MessageToast.show(this.getText("mcErrorFileType", [oEvent.getParameter("fileType")]));
		},

		onRemoveLogo: function () {
			this.getModel("mcDetail").setProperty("/NewLogo", "");
			this.getModel("mcDetail").setProperty("/ClientLogo", "");
			this._resetLogoUploader();
		},

		_resetLogoUploader: function () {
			var oUploader = this.byId("clientLogoUploader");
			if (oUploader) {
				oUploader.setValue("");
			}
		},

		/**
		 * Saves the basic information of the client.
		 */
		onSaveClient: function () {
			var oDetail = this.getModel("mcDetail").getData();

			if (!oDetail.ClientKey) {
				return;
			}
			if (!oDetail.ClientDesc) {
				this.byId("clientName").setValueState("Error");
				this.byId("clientName").setValueStateText(this.getText("mcMandatory"));
				MessageBox.error(this.getText("mcErrorNameRequired"));
				return;
			}
			this.byId("clientName").setValueState("None");

			this._save(CLIENTS_SERVICE + "?cmd=update", {
				orgID: oDetail.OrgID,
				ClientKey: oDetail.ClientKey,
				ClientDesc: oDetail.ClientDesc,
				ClientLocation: oDetail.ClientLocation || "",
				ClientLogo: oDetail.NewLogo || oDetail.ClientLogo || "",
				ClientContactName: oDetail.ClientContactName || "",
				ClientContactMobile: oDetail.ClientContactMobile || "",
				ClientContactEmail: oDetail.ClientContactEmail || ""
			}, "mcSaved", "mcErrorSave").then(function () {
				return this._loadClients().then(function () {
					return this._showClient(oDetail.ClientKey);
				}.bind(this));
			}.bind(this)).catch(function () { /* reported by _save */ });
		},

		/* =========================================================== */
		/* create client                                               */
		/* =========================================================== */

		onOpenAddClient: function () {
			this.getModel("mcForm").setData({
				ClientDesc: "",
				ClientLocation: "",
				ClientContactName: "",
				ClientContactEmail: "",
				ClientContactMobile: "",
				Logo: ""
			});
			this._openDialog("_pAddClientDialog", "bsx.hrx.hrx2026.fragment.AddClientDialog");
		},

		onCancelAddClient: function () {
			this._closeDialog("_pAddClientDialog");
		},

		onNewLogoChange: function (oEvent) {
			var aFiles = oEvent.getParameter("files");
			var oFile = aFiles && aFiles[0];
			if (!oFile) {
				return;
			}

			var oFormModel = this.getModel("mcForm");
			var oReader = new FileReader();
			oReader.onload = function (oLoadEvent) {
				oFormModel.setProperty("/Logo", oLoadEvent.target.result);
			};
			oReader.readAsDataURL(oFile);
		},

		onCreateClient: function () {
			var oForm = this.getModel("mcForm").getData();
			var oNameInput = this.byId("newClientName");

			if (!(oForm.ClientDesc || "").trim()) {
				oNameInput.setValueState("Error");
				oNameInput.setValueStateText(this.getText("mcMandatory"));
				return;
			}
			oNameInput.setValueState("None");

			if (oForm.ClientContactEmail && !EMAIL_PATTERN.test(oForm.ClientContactEmail)) {
				this.byId("newClientEmail").setValueState("Error");
				this.byId("newClientEmail").setValueStateText(this.getText("mcInvalidEmail"));
				return;
			}
			this.byId("newClientEmail").setValueState("None");

			this._save(CLIENTS_SERVICE + "?cmd=new", {
				orgID: this._sOrgId,
				ClientKey: "",
				ClientDesc: oForm.ClientDesc.trim(),
				ClientLocation: oForm.ClientLocation || "",
				ClientLogo: oForm.Logo || "",
				ClientContactName: oForm.ClientContactName || "",
				ClientContactMobile: oForm.ClientContactMobile || "",
				ClientContactEmail: oForm.ClientContactEmail || ""
			}, "mcCreated", "mcErrorCreate").then(function () {
				this._closeDialog("_pAddClientDialog");
				return this._loadClients();
			}.bind(this)).catch(function () { /* reported by _save */ });
		},

		/* =========================================================== */
		/* support team                                                */
		/* =========================================================== */

		onAddUser: function () {
			this.getModel("mcForm").setData({
				mode: "new",
				UserID: "",
				FName: "",
				LName: "",
				Email: "",
				Mobile: "",
				IsActive: true,
				IsAdmin: false
			});
			this._openDialog("_pUserDialog", "bsx.hrx.hrx2026.fragment.ClientUserDialog");
		},

		onEditUser: function (oEvent) {
			var oUser = oEvent.getSource().getBindingContext("mcTabs").getObject();

			this.getModel("mcForm").setData({
				mode: "edit",
				UserID: oUser.UserID,
				FName: formatter.clean(oUser.FName),
				LName: formatter.clean(oUser.LName),
				Email: formatter.clean(oUser.Email),
				Mobile: formatter.clean(oUser.Mobile),
				IsActive: oUser.IsActive === "Y",
				IsAdmin: oUser.IsAdmin === "Y"
			});
			this._openDialog("_pUserDialog", "bsx.hrx.hrx2026.fragment.ClientUserDialog");
		},

		onCancelUser: function () {
			this._closeDialog("_pUserDialog");
		},

		onSaveUser: function () {
			var oForm = this.getModel("mcForm").getData();
			var sClientKey = this.getModel("mcView").getProperty("/selectedId");

			if (!this._validateRequired([
				{ id: "userFirstName", value: oForm.FName },
				{ id: "userLastName", value: oForm.LName }
			])) {
				return;
			}
			if (!EMAIL_PATTERN.test(oForm.Email || "")) {
				this.byId("userEmail").setValueState("Error");
				this.byId("userEmail").setValueStateText(this.getText("mcInvalidEmail"));
				return;
			}
			this.byId("userEmail").setValueState("None");

			var bEdit = oForm.mode === "edit";
			var oPayload = {
				OrgID: sClientKey,
				UserID: bEdit ? oForm.UserID : "",
				FName: oForm.FName.trim(),
				LName: oForm.LName.trim(),
				Email: oForm.Email.trim(),
				Mobile: oForm.Mobile || "",
				IsActive: oForm.IsActive ? "Y" : "N",
				Pic: ""
			};

			// Only the update call carries the admin flag, mirroring the service contract.
			if (bEdit) {
				oPayload.IsAdmin = oForm.IsAdmin ? "Y" : "N";
			}

			this._save(CLIENT_USERS_SERVICE + (bEdit ? "?cmd=update" : "?cmd=new"), oPayload,
				bEdit ? "mcUserUpdated" : "mcUserCreated", "mcErrorUserSave").then(function () {
					this._closeDialog("_pUserDialog");
					return this._loadUsers(sClientKey);
				}.bind(this)).catch(function () { /* reported by _save */ });
		},

		/* =========================================================== */
		/* SLA                                                         */
		/* =========================================================== */

		onAddSla: function () {
			this.getModel("mcForm").setData({
				mode: "new",
				PriorityID: "",
				ResponseSLA: "",
				ResolutionSLA: ""
			});
			this._openDialog("_pSlaDialog", "bsx.hrx.hrx2026.fragment.SlaDialog");
		},

		onEditSla: function (oEvent) {
			var oSla = oEvent.getSource().getBindingContext("mcTabs").getObject();

			this.getModel("mcForm").setData({
				mode: "edit",
				PriorityID: oSla.PriorityID,
				ResponseSLA: formatter.clean(oSla.ResponseSLA),
				ResolutionSLA: formatter.clean(oSla.ResolutionSLA)
			});
			this._openDialog("_pSlaDialog", "bsx.hrx.hrx2026.fragment.SlaDialog");
		},

		onCancelSla: function () {
			this._closeDialog("_pSlaDialog");
		},

		onSaveSla: function () {
			var oForm = this.getModel("mcForm").getData();
			var sClientKey = this.getModel("mcView").getProperty("/selectedId");
			var oSeverity = this.byId("slaSeverity");

			if (!oForm.PriorityID) {
				oSeverity.setValueState("Error");
				oSeverity.setValueStateText(this.getText("mcMandatory"));
				return;
			}
			oSeverity.setValueState("None");

			if (!this._validateRequired([
				{ id: "slaResponse", value: oForm.ResponseSLA },
				{ id: "slaResolution", value: oForm.ResolutionSLA }
			])) {
				return;
			}

			var bEdit = oForm.mode === "edit";
			var sToday = this._today();
			var oPayload = {
				OrgID: sClientKey,
				PriorityID: oForm.PriorityID,
				PriorityDesc: "",
				ResponseSLA: String(oForm.ResponseSLA),
				ResolutionSLA: String(oForm.ResolutionSLA),
				UoM: "",
				CreatedOn: bEdit ? "" : sToday,
				CreatedBy: bEdit ? "" : this._sUserEmail,
				ChangedOn: bEdit ? sToday : "",
				ChangedBy: bEdit ? this._sUserEmail : ""
			};

			this._save(SLA_SERVICE + (bEdit ? "?cmd=update" : "?cmd=new"), oPayload,
				bEdit ? "mcSlaUpdated" : "mcSlaCreated", "mcErrorSlaSave").then(function () {
					this._closeDialog("_pSlaDialog");
					return this._loadSla(sClientKey);
				}.bind(this)).catch(function () { /* reported by _save */ });
		},

		/* =========================================================== */
		/* components                                                  */
		/* =========================================================== */

		onAddComponent: function () {
			this.getModel("mcForm").setData({
				mode: "new",
				SoftwareRecID: "",
				Software: "",
				Component: "",
				SubComponent: "",
				ValidFrom: null,
				ValidTill: null,
				InstallDate: null,
				IsSupported: false,
				SystemNo: "",
				SAPVersion: "",
				ObjectCost: "",
				SupportCost: "",
				IsCloudCustomer: false,
				ShowWarning: false,
				WarningMessage: "",
				HardMessage: ""
			});
			this._refreshComponentValueHelps();
			this._openDialog("_pComponentDialog", "bsx.hrx.hrx2026.fragment.ClientComponentDialog");
		},

		onEditComponent: function (oEvent) {
			var oComponent = oEvent.getSource().getBindingContext("mcTabs").getObject();

			this.getModel("mcForm").setData({
				mode: "edit",
				SoftwareRecID: oComponent.SoftwareRecID,
				Software: oComponent.Software || "",
				Component: oComponent.Component || "",
				SubComponent: oComponent.SubComponent || "",
				ValidFrom: formatter.toDate(oComponent.ValidFrom),
				ValidTill: formatter.toDate(oComponent.ValidTill),
				InstallDate: formatter.toDate(oComponent.InstallDate),
				IsSupported: oComponent.IsSupported === "Y",
				SystemNo: formatter.clean(oComponent.SystemNo),
				SAPVersion: formatter.clean(oComponent.SAPVersion),
				ObjectCost: formatter.clean(oComponent.ObjectCost),
				SupportCost: formatter.clean(oComponent.SupportCost),
				IsCloudCustomer: oComponent.IsCloudCustomer === "Y",
				ShowWarning: oComponent.ShowWarning === "1",
				WarningMessage: formatter.clean(oComponent.WarningMessage),
				HardMessage: formatter.clean(oComponent.HardMessage)
			});
			this._refreshComponentValueHelps();
			this._openDialog("_pComponentDialog", "bsx.hrx.hrx2026.fragment.ClientComponentDialog");
		},

		onCancelComponent: function () {
			this._closeDialog("_pComponentDialog");
		},

		/**
		 * Component and sub-component depend on the chosen software, so the dependent
		 * lists are narrowed whenever the selection above them changes.
		 */
		onSoftwareChange: function () {
			this.getModel("mcForm").setProperty("/Component", "");
			this.getModel("mcForm").setProperty("/SubComponent", "");
			this._refreshComponentValueHelps();
		},

		onComponentChange: function () {
			this.getModel("mcForm").setProperty("/SubComponent", "");
			this._refreshComponentValueHelps();
		},

		_refreshComponentValueHelps: function () {
			var oForm = this.getModel("mcForm").getData();
			var oModel = this.getModel("mc");

			oModel.setProperty("/componentChoices", (oModel.getProperty("/components") || []).filter(function (oComponent) {
				return oComponent.AppID === oForm.Software;
			}));
			oModel.setProperty("/subComponentChoices", (oModel.getProperty("/subComponents") || []).filter(function (oSub) {
				return oSub.AppID === oForm.Software && oSub.ComponentID === oForm.Component;
			}));
		},

		onSaveComponent: function () {
			var oForm = this.getModel("mcForm").getData();
			var sClientKey = this.getModel("mcView").getProperty("/selectedId");
			var oSoftware = this.byId("componentSoftware");

			if (!oForm.Software) {
				oSoftware.setValueState("Error");
				oSoftware.setValueStateText(this.getText("mcMandatory"));
				return;
			}
			oSoftware.setValueState("None");

			var bEdit = oForm.mode === "edit";
			var oPayload = {
				OrgID: this._sOrgId,
				ClientKey: sClientKey,
				Software: oForm.Software,
				Component: oForm.Component || "NA",
				SubComponent: oForm.SubComponent || "NA",
				ValidFrom: this._isoDate(oForm.ValidFrom),
				ValidTill: this._isoDate(oForm.ValidTill),
				IsSupported: oForm.IsSupported ? "Y" : "N",
				SystemNo: oForm.SystemNo || "",
				SAPVersion: oForm.SAPVersion || "",
				InstallDate: this._isoDate(oForm.InstallDate),
				ObjectCost: oForm.ObjectCost || "",
				SupportCost: oForm.SupportCost || "",
				WarningMessage: oForm.WarningMessage || "",
				ShowWarning: oForm.ShowWarning ? "1" : "0",
				HardMessage: oForm.HardMessage || "",
				IsCloudCustomer: oForm.IsCloudCustomer ? "Y" : "N"
			};

			if (bEdit) {
				oPayload.SoftwareRecID = oForm.SoftwareRecID;
			}

			this._save(CLIENT_APPS_SERVICE + (bEdit ? "?cmd=update" : "?cmd=new"), oPayload,
				bEdit ? "mcComponentUpdated" : "mcComponentCreated", "mcErrorComponentSave").then(function () {
					this._closeDialog("_pComponentDialog");
					return this._loadComponents(sClientKey);
				}.bind(this)).catch(function () { /* reported by _save */ });
		},

		onDeleteComponent: function (oEvent) {
			var oComponent = oEvent.getSource().getBindingContext("mcTabs").getObject();
			var sClientKey = this.getModel("mcView").getProperty("/selectedId");

			MessageBox.confirm(this.getText("mcConfirmDeleteComponent", [oComponent.AppName || oComponent.Software]), {
				title: this.getText("mcConfirmDeleteComponentTitle"),
				icon: MessageBox.Icon.WARNING,
				emphasizedAction: MessageBox.Action.CANCEL,
				onClose: function (sAction) {
					if (sAction !== MessageBox.Action.OK) {
						return;
					}
					this._save(CLIENT_APPS_SERVICE + "?cmd=delete", {
						SoftwareRecID: oComponent.SoftwareRecID
					}, "mcComponentDeleted", "mcErrorComponentDelete").then(function () {
						return this._loadComponents(sClientKey);
					}.bind(this)).catch(function () { /* reported by _save */ });
				}.bind(this)
			});
		},

		/* =========================================================== */
		/* application services                                        */
		/* =========================================================== */

		onAddService: function () {
			this.getModel("mcForm").setData({
				AppID: "",
				ServiceID: "",
				ValidFrom: null,
				ValidTill: null
			});
			this._openDialog("_pServiceDialog", "bsx.hrx.hrx2026.fragment.ClientServiceDialog");
		},

		onCancelService: function () {
			this._closeDialog("_pServiceDialog");
		},

		/**
		 * Application services are maintained directly on the OData entity set rather
		 * than through an XS JavaScript service.
		 */
		onSaveService: function () {
			var oForm = this.getModel("mcForm").getData();
			var sClientKey = this.getModel("mcView").getProperty("/selectedId");
			var oApp = this.byId("serviceApp");
			var oService = this.byId("serviceService");

			if (!oForm.AppID) {
				oApp.setValueState("Error");
				oApp.setValueStateText(this.getText("mcMandatory"));
				return;
			}
			oApp.setValueState("None");

			if (!oForm.ServiceID) {
				oService.setValueState("Error");
				oService.setValueStateText(this.getText("mcMandatory"));
				return;
			}
			oService.setValueState("None");

			var oServiceEntry = (this.getModel("mc").getProperty("/services") || []).filter(function (oEntry) {
				return oEntry.ServiceID === oForm.ServiceID;
			})[0];

			var oViewModel = this.getModel("mcView");
			oViewModel.setProperty("/saving", true);

			this._create("/ClientAppServices", {
				ClientKey: sClientKey,
				AppID: oForm.AppID,
				ServiceID: oForm.ServiceID,
				ValidFrom: oForm.ValidFrom || null,
				ValidTill: oForm.ValidTill || null,
				DeployedVersion: "",
				ServiceDesc: oServiceEntry ? oServiceEntry.ServiceDesc : ""
			}).then(function () {
				oViewModel.setProperty("/saving", false);
				MessageToast.show(this.getText("mcServiceCreated"));
				this._closeDialog("_pServiceDialog");
				return this._loadServices(sClientKey);
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/saving", false);
				this._showError("mcErrorServiceSave", oError);
			}.bind(this));
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
		 * POSTs to one of the XS JavaScript services and reports the outcome.
		 * @param {string} sUrl the service url
		 * @param {object} oPayload the request body
		 * @param {string} sSuccessKey i18n key for the success toast
		 * @param {string} sErrorKey i18n key for the error dialog
		 * @returns {Promise} resolved on success, rejected once the error was shown
		 */
		_save: function (sUrl, oPayload, sSuccessKey, sErrorKey) {
			var oViewModel = this.getModel("mcView");
			oViewModel.setProperty("/saving", true);

			return this._postJson(sUrl, oPayload).then(function (oResult) {
				oViewModel.setProperty("/saving", false);
				MessageToast.show(oResult.msg || this.getText(sSuccessKey));
				return oResult;
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/saving", false);
				this._showError(sErrorKey, oError);
				throw oError;
			}.bind(this));
		},

		_validateRequired: function (aFields) {
			var bValid = true;

			aFields.forEach(function (oField) {
				var oControl = this.byId(oField.id);
				var bFilled = !!String(oField.value === undefined || oField.value === null ? "" : oField.value).trim();
				oControl.setValueState(bFilled ? "None" : "Error");
				oControl.setValueStateText(this.getText("mcMandatory"));
				bValid = bValid && bFilled;
			}, this);

			return bValid;
		},

		_read: function (sPath, mParameters) {
			// Backend.read, not a bare model.read: it waits for the service metadata,
			// including the retries Component.js makes after a failed first attempt, so
			// a momentary outage at startup no longer leaves every value help on the
			// page empty for the rest of the session.
			return Backend.read(this.getOwnerComponent().getModel(), sPath, mParameters);
		},

		_create: function (sPath, oEntry) {
			var oModel = this.getOwnerComponent().getModel();

			return new Promise(function (resolve, reject) {
				oModel.create(sPath, oEntry, {
					success: resolve,
					error: reject
				});
			});
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
		 * The XS JavaScript services answer HTTP 200 with a msgType of "S" on success.
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
						throw new Error((oJson && (oJson.msg || oJson.message)) || sBody || oResponse.statusText);
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

		/**
		 * Removes the OData __metadata wrapper so the rows can be bound from a JSON model.
		 * @param {object} oData an OData read result
		 * @returns {Array<object>} plain rows
		 */
		_strip: function (oData) {
			return (oData.results || []).map(function (oRow) {
				var oCopy = Object.assign({}, oRow);
				delete oCopy.__metadata;
				return oCopy;
			});
		},

		_isoDate: function (vDate) {
			var oDate = formatter.toDate(vDate);
			if (!oDate) {
				return "";
			}
			var sMonth = String(oDate.getMonth() + 1).padStart(2, "0");
			var sDay = String(oDate.getDate()).padStart(2, "0");
			return oDate.getFullYear() + "-" + sMonth + "-" + sDay;
		},

		_today: function () {
			return this._isoDate(new Date());
		},

		_resolveOrgId: function () {
			this._sUserEmail = CurrentUser.email(this.getOwnerComponent());
			return CurrentUser.orgId(this.getOwnerComponent());
		},

		_emptyTabs: function () {
			return { users: [], sla: [], components: [], services: [] };
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
					return oBody.msg || (oBody.error && oBody.error.message && oBody.error.message.value) || oError.responseText;
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
