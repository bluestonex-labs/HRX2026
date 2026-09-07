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

	var TEAM_SERVICE = SERVICE_ROOT + "/hrx/teamCalendar1.xsjs";
	var LEAVE_REQS_SERVICE = SERVICE_ROOT + "/hrx/leaveReqs.xsjs";
	var LEAVE_APPROVALS_SERVICE = SERVICE_ROOT + "/hrx/leaveApprovals.xsjs";

	// The calendar colours each leave type through its appointment type.
	var LEAVE_TYPES = {
		HOLIL: { type: "Type01", icon: "sap-icon://general-leave-request" },
		SICKL: { type: "Type02", icon: "sap-icon://bed" },
		UNPDL: { type: "Type03", icon: "sap-icon://unpaid-leave" },
		COMPL: { type: "Type04", icon: "sap-icon://e-care" },
		MATEL: { type: "Type06", icon: "sap-icon://family-care" },
		PATEL: { type: "Type07", icon: "sap-icon://family-care" },
		BANKHOLIDAY: { type: "Type05", icon: "sap-icon://calendar" }
	};

	return Controller.extend("bsx.hrx.hrx2026.controller.TeamCalendar", {

		formatter: formatter,

		/* =========================================================== */
		/* lifecycle                                                   */
		/* =========================================================== */

		onInit: function () {
			this._sOrgId = this._resolveOrgId();

			this.setModel(new JSONModel({
				startDate: this._mondayOf(new Date()),
				busy: true,
				saving: false,
				isManager: false,
				hasPendingLeave: false,
				currentEmail: this._sUserEmail,
				currentName: "",
				currentEmpId: "",
				periodLabel: "",
				title: this.getText("tcTitle"),
				selectedResources: []
			}), "tcView");

			this.setModel(new JSONModel({
				people: [],
				allPeople: [],
				directory: [],
				leaveTypes: [],
				reportees: [],
				approvals: [],
				dates: []
			}), "tc");

			this.setModel(new JSONModel(this._emptyLeaveForm()), "tcForm");

			this._pDirectoryLoaded = this._loadDirectory();

			this.getOwnerComponent().getRouter().getRoute("teamcal")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		/**
		 * The view is reused across navigations, so every entry returns to the current
		 * month with no resource filter applied.
		 */
		_onRouteMatched: function () {
			var oViewModel = this.getModel("tcView");
			oViewModel.setProperty("/startDate", this._mondayOf(new Date()));
			oViewModel.setProperty("/selectedResources", []);
			this._pDirectoryLoaded.then(this._loadTeam.bind(this));
		},

		/* =========================================================== */
		/* data loading                                                */
		/* =========================================================== */

		/**
		 * Loads the resource directory that backs the "viewing as" picker and the leave
		 * type value help. Both are stable, so they are fetched once.
		 * Scoped to the signed-in manager's own direct reports (plus themselves) - not
		 * the whole org - so a manager can only view calendars they are entitled to see.
		 * @returns {Promise} resolved once the lookups are in the model
		 */
		_loadDirectory: function () {
			var oModel = this.getModel("tc");
			var sManagerId = CurrentUser.get() && CurrentUser.get().empID;

			return Promise.all([
				this._read("/Resources", {
					urlParameters: { "$select": "EmpID,FName,LName,Email,IsActive,UserTypeKey,ManagerID" },
					filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)]
				}),
				this._read("/LeaveTypes", {
					filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)]
				})
			]).then(function (aResults) {
				var aDirectory = this._strip(aResults[0])
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
					});

				oModel.setProperty("/directory", aDirectory);
				oModel.setProperty("/leaveTypes", this._strip(aResults[1]));
			}.bind(this)).catch(function (oError) {
				this._showError("tcErrorLookups", oError);
			}.bind(this));
		},

		/**
		 * Loads everybody's leave for the month shown by the calendar.
		 * @returns {Promise} resolved once the calendar rows are in the model
		 */
		_loadTeam: function () {
			var oViewModel = this.getModel("tcView");
			var oStart = formatter.toDate(oViewModel.getProperty("/startDate")) || new Date();
			var oFirstDay = this._firstOfMonth(oStart);

			// A week can straddle two months, so the period runs to the end of whichever
			// month the last visible day falls in.
			var oLastVisible = new Date(oStart.getFullYear(), oStart.getMonth(), oStart.getDate() + 6);
			var oLastDay = new Date(oLastVisible.getFullYear(), oLastVisible.getMonth() + 1, 0);

			oViewModel.setProperty("/busy", true);
			oViewModel.setProperty("/periodLabel", formatter.dateRange(oFirstDay, oLastDay));

			return this._getJson(TEAM_SERVICE + "?cmd=team&" + new URLSearchParams({
				OrgID: this._sOrgId,
				Email: oViewModel.getProperty("/currentEmail"), //"gaurav.kumar@bluestonex.com",
				FromDate: this._isoDate(oFirstDay),
				ToDate: this._isoDate(oLastDay)
			}).toString()).then(function (oData) {
				var oUser = (oData.loggedinUser || [])[0] || {};

				oViewModel.setProperty("/currentName", oUser.Name || "");
				oViewModel.setProperty("/currentEmpId", oUser.EmpID || "");
				oViewModel.setProperty("/isManager", oUser.IsManager === "Y");
				oViewModel.setProperty("/hasPendingLeave", oUser.HasPendingLeaves === "Y");

				this.getModel("tc").setProperty("/allPeople", (oData.users || []).map(this._toRow, this));
				this._applyResourceFilter();
				oViewModel.setProperty("/busy", false);
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/busy", false);
				this.getModel("tc").setProperty("/allPeople", []);
				this._applyResourceFilter();
				this._showError("tcErrorTeam", oError);
			}.bind(this));
		},

		/**
		 * Turns one person's leave records into planning calendar appointments. Half days
		 * occupy the matching half of the day so they read correctly on the timeline.
		 * @param {object} oUser a person as returned by the service
		 * @returns {object} the calendar row
		 */
		_toRow: function (oUser) {
			var aAppointments = (oUser.Leave || []).map(function (oLeave) {
				var oDate = formatter.toDate(oLeave.Date);
				if (!oDate) {
					return null;
				}

				var sAbsence = oLeave.AbsenceType;
				var iStartHour = sAbsence === "PM" ? 13 : 0;
				var iEndHour = sAbsence === "AM" ? 13 : 23;
				var iEndMinute = sAbsence === "AM" ? 0 : 59;

				var oMeta = LEAVE_TYPES[oLeave.LeaveTypeID] || {};

				return {
					start: new Date(oDate.getFullYear(), oDate.getMonth(), oDate.getDate(), iStartHour, 0),
					end: new Date(oDate.getFullYear(), oDate.getMonth(), oDate.getDate(), iEndHour, iEndMinute),
					title: oLeave.LeaveType,
					info: oLeave.LeaveTypeID === "BANKHOLIDAY" ? this.getText("tcBankHoliday") : sAbsence,
					type: oMeta.type || "Type09",
					icon: oMeta.icon,
					// Requested leave is drawn as tentative until it is approved.
					tentative: oLeave.StatusID !== "APR",
					status: oLeave.Status,
					statusId: oLeave.StatusID,
					requester: oLeave.RequesterName,
					comments: oLeave.RequesterComments
				};
			}, this).filter(Boolean);

			return {
				EmpID: oUser.EmpID,
				Name: oUser.Name,
				Email: oUser.Email,
				SiteID: oUser.SiteID,
				Pic: oUser.Pic || "",
				IsLoggedinUser: oUser.IsLoggedinUser === "Y",
				LeaveCount: aAppointments.length,
				Leave: aAppointments
			};
		},

		/**
		 * Narrows the calendar to the resources picked in the toolbar.
		 */
		_applyResourceFilter: function () {
			var oViewModel = this.getModel("tcView");
			var aSelected = oViewModel.getProperty("/selectedResources") || [];
			var aAll = this.getModel("tc").getProperty("/allPeople") || [];

			var aPeople = aSelected.length
				? aAll.filter(function (oPerson) {
					return aSelected.indexOf(oPerson.EmpID) !== -1;
				})
				: aAll;

			this.getModel("tc").setProperty("/people", aPeople);
			oViewModel.setProperty("/title", this.getText("tcTitleCount", [aPeople.length]));
		},

		/* =========================================================== */
		/* calendar events                                             */
		/* =========================================================== */

		onStartDateChange: function (oEvent) {
			this.getModel("tcView").setProperty("/startDate", oEvent.getSource().getStartDate());
			this._loadTeam();
		},

		onResourceFilterChange: function (oEvent) {
			this.getModel("tcView").setProperty("/selectedResources", oEvent.getSource().getSelectedKeys());
			this._applyResourceFilter();
		},

		onViewAsChange: function (oEvent) {
			var sEmail = oEvent.getSource().getSelectedKey();
			if (!sEmail) {
				return;
			}
			this.getModel("tcView").setProperty("/currentEmail", sEmail);
			this._loadTeam();
		},

		onRefresh: function () {
			this._loadTeam();
		},

		/**
		 * Shows the detail of the selected leave rather than leaving the click silent.
		 * @param {sap.ui.base.Event} oEvent the appointmentSelect event
		 */
		onAppointmentSelect: function (oEvent) {
			var oAppointment = oEvent.getParameter("appointment");
			if (!oAppointment) {
				return;
			}

			var oContext = oAppointment.getBindingContext("tc");
			var oLeave = oContext && oContext.getObject();
			if (!oLeave) {
				return;
			}

			var oRow = oAppointment.getParent();
			var oRowContext = oRow && oRow.getBindingContext("tc");
			var sName = oRowContext ? oRowContext.getProperty("Name") : "";

			MessageBox.information(this.getText("tcLeaveDetail", [
				oLeave.title,
				oLeave.info,
				formatter.date(oLeave.start),
				oLeave.status || ""
			]), {
				title: sName
			});
		},

		/* =========================================================== */
		/* book leave                                                  */
		/* =========================================================== */

		onOpenBookLeave: function () {
			this.getModel("tcForm").setData(this._emptyLeaveForm());
			this._loadReportees();
			this._openDialog("_pBookLeaveDialog", "bsx.hrx.hrx2026.fragment.BookLeaveDialog");
		},

		onCancelBookLeave: function () {
			this._closeDialog("_pBookLeaveDialog");
		},

		/**
		 * Loads the people the signed-in user manages - only they can have leave booked
		 * on their behalf.
		 * @returns {Promise} resolved once the reportees are in the model
		 */
		_loadReportees: function () {
			var sManagerId = this.getModel("tcView").getProperty("/currentEmpId");

			return this._read("/Resources", {
				urlParameters: { "$select": "EmpID,FName,LName,Email,BaseSiteKey,IsActive" },
				filters: [
					new Filter("OrgID", FilterOperator.EQ, this._sOrgId),
					new Filter("ManagerID", FilterOperator.EQ, sManagerId)
				]
			}).then(function (oData) {
				this.getModel("tc").setProperty("/reportees", this._strip(oData)
					.filter(function (oResource) {
						return oResource.IsActive === "Y";
					})
					.map(function (oResource) {
						oResource.FullName = ((oResource.FName || "") + " " + (oResource.LName || "")).trim();
						return oResource;
					})
					.sort(function (a, b) {
						return a.FullName.localeCompare(b.FullName);
					}));
			}.bind(this)).catch(function (oError) {
				this._showError("tcErrorReportees", oError);
			}.bind(this));
		},

		onEmployeeChange: function (oEvent) {
			var sEmpId = oEvent.getSource().getSelectedKey();
			var oEmployee = (this.getModel("tc").getProperty("/reportees") || []).filter(function (oResource) {
				return oResource.EmpID === sEmpId;
			})[0];

			var oForm = this.getModel("tcForm");
			oForm.setProperty("/EmpID", sEmpId);
			oForm.setProperty("/EmpName", oEmployee ? oEmployee.FullName : "");
			oForm.setProperty("/EmpEmail", oEmployee ? oEmployee.Email : "");
			oForm.setProperty("/SiteID", oEmployee ? oEmployee.BaseSiteKey : "");

			if (oForm.getProperty("/FromDate")) {
				this._loadLeaveDates();
			}
		},

		onLeaveDatesChange: function (oEvent) {
			var oForm = this.getModel("tcForm");
			var bValid = oEvent.getParameter("valid") && !!oEvent.getParameter("value");

			oEvent.getSource().setValueState(bValid ? "None" : "Error");
			oEvent.getSource().setValueStateText(this.getText("tcMandatory"));

			if (!bValid) {
				oForm.setProperty("/FromDate", null);
				oForm.setProperty("/ToDate", null);
				this.getModel("tc").setProperty("/dates", []);
				this._updateDayCount();
				return;
			}

			oForm.setProperty("/FromDate", oEvent.getParameter("from"));
			oForm.setProperty("/ToDate", oEvent.getParameter("to"));

			if (!oForm.getProperty("/EmpID")) {
				MessageToast.show(this.getText("tcSelectEmployeeFirst"));
				return;
			}
			this._loadLeaveDates();
		},

		/**
		 * Asks the service which of the chosen days are actually bookable - weekends,
		 * bank holidays and days already taken are left out, and part-booked days come
		 * back with only their free half available.
		 * @returns {Promise} resolved once the day list is in the model
		 */
		_loadLeaveDates: function () {
			var oForm = this.getModel("tcForm").getData();

			return this._getJson(LEAVE_REQS_SERVICE + "?cmd=getDates&" + new URLSearchParams({
				FromDate: this._isoDate(oForm.FromDate),
				ToDate: this._isoDate(oForm.ToDate),
				OrgID: this._sOrgId,
				SiteID: oForm.SiteID || "",
				EmpID: oForm.EmpID
			}).toString()).then(function (oData) {
				this.getModel("tc").setProperty("/dates", (oData.dates || []).map(function (oDay) {
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
				this.getModel("tc").setProperty("/dates", []);
				this._updateDayCount();
				this._showError("tcErrorDates", oError);
			}.bind(this));
		},

		/**
		 * Half days count as 0.5 towards the booking.
		 */
		_updateDayCount: function () {
			var aDates = this.getModel("tc").getProperty("/dates") || [];
			var fDays = aDates.reduce(function (fTotal, oDay) {
				return fTotal + (oDay.SelectedKey === "F" ? 1 : 0.5);
			}, 0);

			this.getModel("tcForm").setProperty("/NoOfDays", fDays);
		},

		onOpenHalfDays: function () {
			this._openDialog("_pHalfDayDialog", "bsx.hrx.hrx2026.fragment.HalfDayDialog");
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
		 * Books the leave. A manager booking on someone's behalf is approved straight
		 * away, which is what the standalone app did.
		 */
		onBookLeave: function () {
			var oViewModel = this.getModel("tcView");
			var oForm = this.getModel("tcForm").getData();
			var aDates = this.getModel("tc").getProperty("/dates") || [];

			this._markValueState("bookLeaveEmployee", !!oForm.EmpID);
			if (!oForm.EmpID) {
				return;
			}

			if (!aDates.length) {
				MessageToast.show(this.getText("tcNoBookableDays"));
				return;
			}

			var sToday = this._isoDate(new Date());
			var sManagerId = oViewModel.getProperty("/currentEmpId");

			var aLeaveRequests = aDates.map(function (oDay) {
				return {
					OrgID: this._sOrgId,
					LeaveID: "",
					EmpID: oForm.EmpID,
					EmpName: oForm.EmpName,
					EmpEmail: oForm.EmpEmail,
					EmpSite: oForm.SiteID || "",
					IsPaid: oForm.LeaveCategoryId === "UNPDL" ? "N" : "Y",
					LeaveCategoryId: oForm.LeaveCategoryId,
					NoOfDays: "1",
					StartDate: oDay.date,
					EndDate: oDay.date,
					DayTime: oDay.SelectedKey === "A" ? "AM" : oDay.SelectedKey === "P" ? "PM" : "Full Day",
					CreatedBy: sManagerId,
					CreatedOn: sToday,
					ApprovalRequired: "N",
					ApproverID: sManagerId,
					ApproverName: oViewModel.getProperty("/currentName"),
					ApproverEmail: oViewModel.getProperty("/currentEmail"),
					Status: "APR",
					ApprovedOn: sToday,
					ApprovedBy: sManagerId,
					RequesterComments: oForm.Comments || "",
					ApproverComments: ""
				};
			}, this);

			this._save(LEAVE_REQS_SERVICE + "?cmd=requestLeave", { LeaveReqSet: aLeaveRequests },
				"tcLeaveBooked", "tcErrorBookLeave").then(function () {
					this._closeDialog("_pBookLeaveDialog");
					return this._loadTeam();
				}.bind(this)).catch(function () { /* reported by _save */ });
		},

		/* =========================================================== */
		/* approvals                                                   */
		/* =========================================================== */

		onOpenApprovals: function () {
			this._loadApprovals();
			this._openDialog("_pApprovalsDialog", "bsx.hrx.hrx2026.fragment.LeaveApprovalsDialog");
		},

		onCloseApprovals: function () {
			this._closeDialog("_pApprovalsDialog");
			this._loadTeam();
		},

		/**
		 * Loads the leave awaiting the signed-in user's decision, grouped by requester.
		 * @returns {Promise} resolved once the approvals are in the model
		 */
		_loadApprovals: function () {
			var oViewModel = this.getModel("tcView");
			oViewModel.setProperty("/saving", true);

			return this._getJson(LEAVE_APPROVALS_SERVICE + "?cmd=pendingApproval&" + new URLSearchParams({
				Email: oViewModel.getProperty("/currentEmail"),
				OrgID: this._sOrgId
			}).toString()).then(function (oData) {
				var mByRequester = {};

				(oData.leaveToApprove || []).forEach(function (oLeave) {
					var oGroup = mByRequester[oLeave.RequesterID];
					if (!oGroup) {
						oGroup = mByRequester[oLeave.RequesterID] = {
							RequesterID: oLeave.RequesterID,
							RequesterName: oLeave.RequesterName,
							RequesterEmail: oLeave.RequesterEmail,
							LeaveList: []
						};
					}
					oGroup.LeaveList.push({
						LeaveID: oLeave.LeaveID,
						DisplayDate: oLeave.DisplayDate,
						AbsenceType: oLeave.AbsenceType,
						LeaveType: oLeave.LeaveType,
						LeaveTypeID: oLeave.LeaveTypeID,
						icon: (LEAVE_TYPES[oLeave.LeaveTypeID] || {}).icon,
						RequesterComments: oLeave.RequesterComments,
						Status: oLeave.Status,
						StatusID: oLeave.StatusID
					});
				});

				this.getModel("tc").setProperty("/approvals", Object.keys(mByRequester).map(function (sKey) {
					return mByRequester[sKey];
				}));
				oViewModel.setProperty("/saving", false);
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/saving", false);
				this.getModel("tc").setProperty("/approvals", []);
				this._showError("tcErrorApprovals", oError);
			}.bind(this));
		},

		onApproveLeave: function (oEvent) {
			this._actionLeave(oEvent, "APR");
		},

		onRejectLeave: function (oEvent) {
			this._actionLeave(oEvent, "REJ");
		},

		/**
		 * Approves or rejects either a single leave day or every pending day of one
		 * requester, depending on which button was pressed.
		 * @param {sap.ui.base.Event} oEvent the button press event
		 * @param {string} sStatus "APR" or "REJ"
		 */
		_actionLeave: function (oEvent, sStatus) {
			var oViewModel = this.getModel("tcView");
			var oContext = oEvent.getSource().getBindingContext("tc");
			if (!oContext) {
				return;
			}

			var oItem = oContext.getObject();
			var bSingleDay = !!oItem.LeaveID;
			var oGroup = bSingleDay ? this._groupOf(oContext) : oItem;
			if (!oGroup) {
				return;
			}

			var sToday = this._isoDate(new Date());
			var aLeaves = bSingleDay ? [oItem] : oGroup.LeaveList;

			var aLeaveRequests = aLeaves.map(function (oLeave) {
				return {
					LeaveID: oLeave.LeaveID,
					RequesterID: oGroup.RequesterID,
					RequesterName: oGroup.RequesterName,
					RequesterEmail: oGroup.RequesterEmail,
					Status: sStatus,
					OrgID: this._sOrgId,
					ApprovedOn: sToday,
					ApprovedBy: oViewModel.getProperty("/currentEmpId"),
					ApproverName: oViewModel.getProperty("/currentName"),
					ApproverEmail: oViewModel.getProperty("/currentEmail")
				};
			}, this);

			this._save(LEAVE_APPROVALS_SERVICE + "?cmd=action", { LeaveReqSet: aLeaveRequests },
				sStatus === "APR" ? "tcLeaveApproved" : "tcLeaveRejected", "tcErrorApprovalAction")
				.then(function () {
					return this._loadApprovals();
				}.bind(this)).catch(function () { /* reported by _save */ });
		},

		/**
		 * Walks from a leave row back up to the requester it belongs to.
		 * @param {sap.ui.model.Context} oContext the leave context
		 * @returns {object|null} the requester group
		 */
		_groupOf: function (oContext) {
			var aMatch = /^\/approvals\/(\d+)\//.exec(oContext.getPath());
			if (!aMatch) {
				return null;
			}
			return this.getModel("tc").getProperty("/approvals/" + aMatch[1]);
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
		 * Flags a field as valid or not. The control only exists once its dialog has been
		 * loaded, so a missing one is simply skipped.
		 * @param {string} sId the control id inside the view
		 * @param {boolean} bValid whether the field passes
		 */
		_markValueState: function (sId, bValid) {
			var oControl = this.byId(sId);
			if (!oControl) {
				return;
			}
			oControl.setValueState(bValid ? "None" : "Error");
			oControl.setValueStateText(this.getText("tcMandatory"));
		},

		_save: function (sUrl, oPayload, sSuccessKey, sErrorKey) {
			var oViewModel = this.getModel("tcView");
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

		_firstOfMonth: function (oDate) {
			return new Date(oDate.getFullYear(), oDate.getMonth(), 1);
		},

		/**
		 * @param {Date} oDate any day
		 * @returns {Date} the Monday of that day's week
		 */
		_mondayOf: function (oDate) {
			var oCopy = new Date(oDate.getFullYear(), oDate.getMonth(), oDate.getDate());
			oCopy.setDate(oCopy.getDate() - ((oCopy.getDay() + 6) % 7));
			return oCopy;
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

		_emptyLeaveForm: function () {
			return {
				EmpID: "",
				EmpName: "",
				EmpEmail: "",
				SiteID: "",
				FromDate: null,
				ToDate: null,
				LeaveCategoryId: "HOLIL",
				Comments: "",
				NoOfDays: 0
			};
		},

		_resolveOrgId: function () {
			this._sUserEmail = CurrentUser.email(this.getOwnerComponent());
			return CurrentUser.orgId(this.getOwnerComponent());
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
