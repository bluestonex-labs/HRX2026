sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/core/Fragment",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/ui/unified/DateTypeRange",
	"sap/m/MessageToast",
	"sap/m/MessageBox",
	"../model/Backend",
	"../model/CurrentUser",
	"../model/formatter"
], function (Controller, Fragment, JSONModel, Filter, FilterOperator, DateTypeRange,
	MessageToast, MessageBox, Backend, CurrentUser, formatter) {
	"use strict";

	// Root path of the backend services - see xs-app.json (deployed) and ui5.yaml (local).
	var LEAVE_SERVICE = Backend.LEAVE;

	// Calendar day types, shared with the legend so the colours stay in step.
	var LEAVE_TYPES = {
		HOLIL: { type: "Type01", text: "Holiday" },
		SICKL: { type: "Type02", text: "Sick" },
		UNPDL: { type: "Type03", text: "Unpaid" },
		COMPL: { type: "Type04", text: "Compassionate" },
		MATEL: { type: "Type06", text: "Maternity" },
		PATEL: { type: "Type07", text: "Paternity" },
		BANKHOLIDAY: { type: "Type05", text: "Bank holiday" }
	};

	return Controller.extend("bsx.hrx.hrx2026.controller.Leave", {

		formatter: formatter,

		/* =========================================================== */
		/* lifecycle                                                   */
		/* =========================================================== */

		onInit: function () {
			// No lookup here: the signed-in user is still being resolved, and reading
			// the email now hands back "" on a browser refresh - which the services read
			// as "match anybody", so the page filled in with somebody else's details.
			// Everything waits on the profile in _onRouteMatched instead.
			this._sOrgId = CurrentUser.orgId(this.getOwnerComponent());
			this._sUserEmail = "";

			this.setModel(new JSONModel({
				busy: true,
				saving: false,
				currentEmail: "",
				statusFilter: "All",
				kpis: this._emptyKpis(),
				user: {}
			}), "mlView");

			this.setModel(new JSONModel({
				availedLeaves: [],
				leaves: [],
				bankHolidays: [],
				analytics: [],
				leaveTypes: [],
				directory: [],
				dates: []
			}), "ml");

			this.setModel(new JSONModel(this._emptyRequest()), "mlForm");
			this.setModel(new JSONModel({}), "mlEdit");

			this.getOwnerComponent().getRouter().getRoute("leave")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		/**
		 * The view is reused across navigations, so every entry reloads the balance and
		 * clears any half-finished request.
		 *
		 * Landing here straight from a browser refresh runs onInit while the profile
		 * lookup Component.js started is still in flight, so nothing may be fetched
		 * until it has landed - fetchUser with no email comes back for no one in
		 * particular, which is what put another person's quota and approver on screen.
		 */
		_onRouteMatched: function () {
			this.getModel("mlView").setProperty("/statusFilter", "All");
			this._resetRequestForm();

			return CurrentUser.ready(this.getOwnerComponent()).then(function (oProfile) {
				this._sUserEmail = oProfile.email;
				this._sOrgId = oProfile.orgId;
				this.getModel("mlView").setProperty("/currentEmail", this._sUserEmail);

				if (!this._sUserEmail) {
					this.getModel("mlView").setProperty("/busy", false);
					this._showError("mlErrorNoIdentity", null);
					return undefined;
				}

				// The directory is filtered against the signed-in user, so it can only be
				// read once that user is known.
				this._pLookupsLoaded = this._pLookupsLoaded || this._loadLookups();
				return this._pLookupsLoaded.then(this._loadUser.bind(this));
			}.bind(this));
		},

		/* =========================================================== */
		/* data loading                                                */
		/* =========================================================== */

		/**
		 * Loads the leave type value help and the resource directory that backs the
		 * "viewing as" picker. Both are stable, so they are fetched once.
		 * Scoped to the signed-in manager's own direct reports (plus themselves) - not
		 * the whole org - so a manager can only view leave they are entitled to see.
		 * @returns {Promise} resolved once the lookups are in the model
		 */
		_loadLookups: function () {
			var oModel = this.getModel("ml");
			var sManagerId = CurrentUser.get() && CurrentUser.get().empID;

			return Promise.all([
				this._read("/LeaveTypes", {
					filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)]
				}),
				this._read("/Resources", {
					urlParameters: { "$select": "EmpID,FName,LName,Email,IsActive,ManagerID" },
					filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)]
				})
			]).then(function (aResults) {
				oModel.setProperty("/leaveTypes", this._strip(aResults[0]));
				oModel.setProperty("/directory", this._strip(aResults[1])
					.filter(function (oResource) {
						return oResource.IsActive === "Y" && oResource.Email &&
							(oResource.Email === this._sUserEmail || oResource.ManagerID === sManagerId);
					}.bind(this))
					.map(function (oResource) {
						oResource.FullName = ((oResource.FName || "") + " " + (oResource.LName || "")).trim();
						return oResource;
					})
					.sort(function (a, b) {
						return a.FullName.localeCompare(b.FullName);
					}));
			}.bind(this)).catch(function (oError) {
				this._showError("mlErrorLookups", oError);
			}.bind(this));
		},

		/**
		 * Loads the quota, the leave taken so far and the per-type breakdown.
		 * @returns {Promise} resolved once the page is filled
		 */
		_loadUser: function () {
			var oViewModel = this.getModel("mlView");
			oViewModel.setProperty("/busy", true);

			return this._getJson(LEAVE_SERVICE + "?cmd=fetchUser&" + new URLSearchParams({
				Email: oViewModel.getProperty("/currentEmail"),
				OrgID: this._sOrgId
			}).toString()).then(function (oData) {
				var oUser = oData.user || {};
				var oModel = this.getModel("ml");

				oViewModel.setProperty("/user", oUser);
				oViewModel.setProperty("/kpis", {
					quota: oUser.annualLeaveQuota || "0",
					used: oUser.noOfAvailedLeaves || "0",
					balance: oUser.balanceLeaves || "0",
					balanceState: parseFloat(oUser.balanceLeaves) > 0 ? "Good" : "Critical"
				});

				oModel.setProperty("/availedLeaves", oData.availedLeaves || []);
				oModel.setProperty("/bankHolidays", oData.bankHolidays || []);
				oModel.setProperty("/analytics", (oData.analyticsData || []).filter(function (oEntry) {
					return parseFloat(oEntry.Days) > 0;
				}));

				this._applyStatusFilter();
				this._renderCalendar();
				oViewModel.setProperty("/busy", false);
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/busy", false);
				this.getModel("ml").setProperty("/availedLeaves", []);
				this._applyStatusFilter();
				this._showError("mlErrorUser", oError);
			}.bind(this));
		},

		/**
		 * Narrows the leave table to the status chosen in the tab bar.
		 */
		_applyStatusFilter: function () {
			var sStatus = this.getModel("mlView").getProperty("/statusFilter");
			var aAll = this.getModel("ml").getProperty("/availedLeaves") || [];

			this.getModel("ml").setProperty("/leaves", aAll.filter(function (oLeave) {
				return sStatus === "All" || oLeave.Status === sStatus;
			}));
		},

		onStatusFilter: function (oEvent) {
			this.getModel("mlView").setProperty("/statusFilter", oEvent.getParameter("key"));
			this._applyStatusFilter();
		},

		/**
		 * Marks every booked day on the calendar in its leave type's colour. The legend
		 * itself is static (see the view) so every leave type is always listed, not just
		 * the ones booked in the currently loaded range.
		 */
		_renderCalendar: function () {
			var oCalendar = this.byId("leaveCalendar");
			if (!oCalendar) {
				return;
			}

			oCalendar.destroySpecialDates();

			var fnMark = function (sDate, sTypeId, sTooltip) {
				var oDate = formatter.toDate(sDate);
				var oMeta = LEAVE_TYPES[sTypeId];
				if (!oDate || !oMeta) {
					return;
				}

				oCalendar.addSpecialDate(new DateTypeRange({
					startDate: oDate,
					type: oMeta.type,
					tooltip: sTooltip
				}));
			};

			(this.getModel("ml").getProperty("/availedLeaves") || []).forEach(function (oLeave) {
				if (oLeave.Status === "Rejected") {
					return;
				}
				fnMark(oLeave.Date, oLeave.LeaveTypeID, oLeave.LeaveType + " (" + oLeave.Absence + ") — " + oLeave.Status);
			});
			(this.getModel("ml").getProperty("/bankHolidays") || []).forEach(function (oHoliday) {
				fnMark(oHoliday.Date, "BANKHOLIDAY", LEAVE_TYPES.BANKHOLIDAY.text);
			});
		},

		onViewAsChange: function (oEvent) {
			var sEmail = oEvent.getSource().getSelectedKey();
			if (!sEmail) {
				return;
			}
			this.getModel("mlView").setProperty("/currentEmail", sEmail);
			this._resetRequestForm();
			this._loadUser();
		},

		onRefresh: function () {
			this._loadUser();
		},

		/* =========================================================== */
		/* new request                                                 */
		/* =========================================================== */

		/**
		 * Asks the service which of the chosen days can actually be booked - weekends,
		 * bank holidays and days already taken drop out, and a part-booked day comes back
		 * with only its free half available.
		 * @param {sap.ui.base.Event} oEvent the date range change event
		 */
		onDatesChange: function (oEvent) {
			var oForm = this.getModel("mlForm");
			var bValid = oEvent.getParameter("valid") && !!oEvent.getParameter("value");

			oEvent.getSource().setValueState(bValid ? "None" : "Error");
			oEvent.getSource().setValueStateText(this.getText("mlMandatory"));

			if (!bValid) {
				oForm.setProperty("/FromDate", null);
				oForm.setProperty("/ToDate", null);
				this.getModel("ml").setProperty("/dates", []);
				this._updateDayCount();
				return;
			}

			oForm.setProperty("/FromDate", oEvent.getParameter("from"));
			oForm.setProperty("/ToDate", oEvent.getParameter("to"));
			this._loadLeaveDates();
		},

		_loadLeaveDates: function () {
			var oForm = this.getModel("mlForm").getData();
			var oUser = this.getModel("mlView").getProperty("/user") || {};

			return this._getJson(LEAVE_SERVICE + "?cmd=getDates&" + new URLSearchParams({
				FromDate: this._isoDate(oForm.FromDate),
				ToDate: this._isoDate(oForm.ToDate),
				OrgID: this._sOrgId,
				SiteID: oUser.siteID || "",
				EmpID: oUser.empID || ""
			}).toString()).then(function (oData) {
				this.getModel("ml").setProperty("/dates", (oData.dates || []).map(function (oDay) {
					var sSlot = oDay.availableSlot;
					return Object.assign({}, oDay, {
						SelectedKey: sSlot === "AM" ? "A" : sSlot === "PM" ? "P" : "F",
						FullDayEnabled: sSlot === "",
						AMEnabled: sSlot === "" || sSlot === "AM",
						PMEnabled: sSlot === "" || sSlot === "PM"
					});
				}));
				this._updateDayCount();
			}.bind(this)).catch(function (oError) {
				this.getModel("ml").setProperty("/dates", []);
				this._updateDayCount();
				this._showError("mlErrorDates", oError);
			}.bind(this));
		},

		/**
		 * Half days count as 0.5 towards the request.
		 */
		_updateDayCount: function () {
			var aDates = this.getModel("ml").getProperty("/dates") || [];
			var fDays = aDates.reduce(function (fTotal, oDay) {
				return fTotal + (oDay.SelectedKey === "F" ? 1 : 0.5);
			}, 0);

			this.getModel("mlForm").setProperty("/NoOfDays", fDays);
		},

		onOpenHalfDays: function () {
			this._openDialog("_pHalfDayDialog", "bsx.hrx.hrx2026.fragment.LeaveHalfDayDialog");
		},

		onConfirmHalfDays: function () {
			this._updateDayCount();
			this._closeDialog("_pHalfDayDialog");
		},

		onResetHalfDays: function () {
			this._loadLeaveDates();
			this._closeDialog("_pHalfDayDialog");
		},

		/**
		 * Submits the request for approval by the user's manager.
		 */
		onSubmitLeave: function () {
			var oForm = this.getModel("mlForm").getData();
			var oUser = this.getModel("mlView").getProperty("/user") || {};
			var aDates = this.getModel("ml").getProperty("/dates") || [];

			if (!aDates.length) {
				MessageToast.show(this.getText("mlNoBookableDays"));
				return;
			}
			if (parseFloat(oForm.NoOfDays) > parseFloat(oUser.balanceLeaves || 0) && oForm.LeaveCategoryId === "HOLIL") {
				MessageBox.warning(this.getText("mlWarnOverBalance", [oForm.NoOfDays, oUser.balanceLeaves]));
			}

			var sToday = this._isoDate(new Date());

			var aRequests = aDates.map(function (oDay) {
				return {
					OrgID: this._sOrgId,
					LeaveID: "",
					EmpID: oUser.empID,
					EmpName: oUser.name,
					EmpEmail: this.getModel("mlView").getProperty("/currentEmail"),
					EmpSite: oUser.siteID || "",
					IsPaid: oForm.LeaveCategoryId === "UNPDL" ? "N" : "Y",
					LeaveCategoryId: oForm.LeaveCategoryId,
					NoOfDays: "1",
					StartDate: oDay.date,
					EndDate: oDay.date,
					DayTime: oDay.SelectedKey === "A" ? "AM" : oDay.SelectedKey === "P" ? "PM" : "Full Day",
					CreatedBy: oUser.empID,
					CreatedOn: sToday,
					ApprovalRequired: "Y",
					ApproverID: oUser.managerID || "",
					ApproverName: oUser.managerName || "",
					ApproverEmail: oUser.managerEmail || "",
					Status: "REQ",
					ApprovedOn: "",
					ApprovedBy: "",
					RequesterComments: oForm.Comments || "",
					ApproverComments: ""
				};
			}, this);

			this._save(LEAVE_SERVICE + "?cmd=requestLeave", { LeaveReqSet: aRequests },
				"mlRequested", "mlErrorRequest").then(function () {
					this._resetRequestForm();
					return this._loadUser();
				}.bind(this)).catch(function () { /* reported by _save */ });
		},

		_resetRequestForm: function () {
			this.getModel("mlForm").setData(this._emptyRequest());
			this.getModel("ml").setProperty("/dates", []);

			var oDateRange = this.byId("leaveDateRange");
			if (oDateRange) {
				oDateRange.setValue("");
				oDateRange.setValueState("None");
			}
		},

		/* =========================================================== */
		/* edit an existing leave day                                  */
		/* =========================================================== */

		onEditLeave: function (oEvent) {
			var oContext = oEvent.getSource().getBindingContext("ml");
			if (!oContext) {
				return;
			}

			// An approved day is settled - the row offers no pencil, and a stray event
			// must not open the dialog either.
			if (oContext.getProperty("StatusID") === "APR") {
				return;
			}

			var oLeave = oContext.getObject();

			// Only a request still awaiting a decision can be changed.
			this.getModel("mlEdit").setData(Object.assign({}, oLeave, {
				editable: oLeave.StatusID === "REQ"
			}));
			this._openDialog("_pEditLeaveDialog", "bsx.hrx.hrx2026.fragment.EditLeaveDialog");
		},

		onCloseEditLeave: function () {
			this._closeDialog("_pEditLeaveDialog");
		},

		onUpdateLeave: function () {
			var oLeave = this.getModel("mlEdit").getData();

			this._save(LEAVE_SERVICE + "?cmd=update", {
				OrgID: this._sOrgId,
				LeaveID: oLeave.LeaveID,
				Date: oLeave.Date,
				LeaveType: oLeave.LeaveTypeID,
				Absence: oLeave.Absence
			}, "mlUpdated", "mlErrorUpdate").then(function () {
				this._closeDialog("_pEditLeaveDialog");
				return this._loadUser();
			}.bind(this)).catch(function () { /* reported by _save */ });
		},

		onDeleteLeave: function () {
			var oLeave = this.getModel("mlEdit").getData();

			MessageBox.confirm(this.getText("mlConfirmDelete", [oLeave.DisplayDate, oLeave.LeaveType]), {
				title: this.getText("mlConfirmDeleteTitle"),
				icon: MessageBox.Icon.WARNING,
				emphasizedAction: MessageBox.Action.CANCEL,
				onClose: function (sAction) {
					if (sAction !== MessageBox.Action.OK) {
						return;
					}
					this._save(LEAVE_SERVICE + "?cmd=delete", {
						OrgID: this._sOrgId,
						LeaveID: oLeave.LeaveID,
						Date: oLeave.Date,
						LeaveType: oLeave.LeaveTypeID,
						Absence: oLeave.Absence
					}, "mlDeleted", "mlErrorDelete").then(function () {
						this._closeDialog("_pEditLeaveDialog");
						return this._loadUser();
					}.bind(this)).catch(function () { /* reported by _save */ });
				}.bind(this)
			});
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

		_save: function (sUrl, oPayload, sSuccessKey, sErrorKey) {
			var oViewModel = this.getModel("mlView");
			oViewModel.setProperty("/saving", true);

			return this._request(sUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(oPayload)
			}).then(function (oResult) {
				oViewModel.setProperty("/saving", false);
				MessageToast.show(oResult.msg || this.getText(sSuccessKey));
				return oResult;
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/saving", false);
				this._showError(sErrorKey, oError);
				throw oError;
			}.bind(this));
		},

		_read: function (sPath, mParameters) {
			var oModel = this.getOwnerComponent().getModel();

			return new Promise(function (resolve, reject) {
				oModel.read(sPath, Object.assign({}, mParameters, {
					success: resolve,
					error: reject
				}));
			});
		},

		_getJson: function (sUrl) {
			return this._request(sUrl, { method: "GET" });
		},

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

		_emptyRequest: function () {
			return {
				FromDate: null,
				ToDate: null,
				LeaveCategoryId: "HOLIL",
				Comments: "",
				NoOfDays: 0
			};
		},

		_emptyKpis: function () {
			return { quota: "0", used: "0", balance: "0", balanceState: "Neutral" };
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
