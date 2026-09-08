sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/core/Fragment",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/ui/model/Sorter",
	"sap/m/MessageToast",
	"sap/m/MessageBox",
	"../model/Backend",
	"../model/CurrentUser",
	"../model/formatter"
], function (Controller, Fragment, JSONModel, Filter, FilterOperator, Sorter, MessageToast, MessageBox, Backend, CurrentUser, formatter) {
	"use strict";

	// Root path of the backend services - see xs-app.json (deployed) and ui5.yaml (local).
	var TIMESHEET_SERVICE = Backend.TIMESHEET;

	// abbrev matches the day fields exposed by the /Resources OData entity.
	var DAYS = [
		{ key: "Mon", label: "Mon", schedule: "Monday", abbrev: "Mo" },
		{ key: "Tue", label: "Tue", schedule: "Tuesday", abbrev: "Tu" },
		{ key: "Wed", label: "Wed", schedule: "Wednesday", abbrev: "We" },
		{ key: "Thu", label: "Thu", schedule: "Thursday", abbrev: "Th" },
		{ key: "Fri", label: "Fri", schedule: "Friday", abbrev: "Fr" },
		{ key: "Sat", label: "Sat", schedule: "Saturday", abbrev: "Sa" },
		{ key: "Sun", label: "Sun", schedule: "Sunday", abbrev: "Su" }
	];

	// Internal bookings against this client never need a work description.
	var NO_COMMENT_CLIENT = "BSXCL0000000000";

	// Bluestonex itself: internal work is the only thing on a fresh timesheet, and
	// client projects are put there by the user with "Add Project(s)".
	var INTERNAL_CLIENT = "BSXCL0000000001";

	// A closed month can still be corrected during the first few working days of the next one.
	var GRACE_WORKING_DAYS = 3;

	return Controller.extend("bsx.hrx.hrx2026.controller.Timesheet", {

		formatter: formatter,

		/* =========================================================== */
		/* lifecycle                                                   */
		/* =========================================================== */

		onInit: function () {
			this._sOrgId = this._resolveOrgId();

			this.setModel(new JSONModel({
				busy: true,
				saving: false,
				weekStart: this._mondayOf(new Date()),
				weekLabel: "",
				isManager: false,
				currentEmail: //"gaurav.kumar@bluestonex.com",
				this._sUserEmail,
				userId: "",
				selectedCount: 0,
				dayHeaders: DAYS.map(function (oDay) {
					return { label: oDay.label, date: "", total: "0:00", working: true };
				}),
				weekBooked: "0:00",
				weekTarget: "0:00",
				weekPercent: 0,
				kpis: this._emptyKpis()
			}), "tsView");

			this.setModel(new JSONModel({
				rows: [],
				available: [],
				directory: []
			}), "ts");

			this._applyRowsGrouping();

			this.setModel(new JSONModel({ comment: "", label: "" }), "tsComment");

			this._pDirectoryLoaded = this._loadDirectory();

			this.getOwnerComponent().getRouter().getRoute("timesheet")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		/**
		 * The view is reused across navigations, so every entry returns to the current
		 * week with fresh data.
		 */
		_onRouteMatched: function () {
			this.getModel("tsView").setProperty("/weekStart", this._mondayOf(new Date()));

			// Every entry to the screen starts on whoever is signed in, with their own
			// name showing in the picker - the view is reused across navigations, so
			// without this it would come back holding whatever was last looked at.
			this._sViewAsEmail = this._sUserEmail;
			this.getModel("tsView").setProperty("/currentEmail", this._sUserEmail);

			this._pDirectoryLoaded.then(function () {
				this._restoreViewAs();
				return this._loadWeek();
			}.bind(this));
		},

		/**
		 * Groups on client (project rows) or "Leave and holidays" (the non-working rows),
		 * sorted alphabetically - except the leave/holidays group, which always sorts last
		 * regardless of where its label would otherwise fall.
		 */
		_applyRowsGrouping: function () {
			var oBinding = this.byId("timesheetTable").getBinding("items");
			if (oBinding) {
				oBinding.sort(new Sorter("ClientDesc", false, true, this._compareGroups.bind(this)));
			}
		},

		_compareGroups: function (a, b) {
			// SorterProcessor upper-cases string values before handing them to a custom
			// comparator, so the group label needs the same treatment to compare equal.
			var sAbsences = this.getText("tsAbsences").toLocaleUpperCase();
			var bAIsAbsences = a === sAbsences;
			var bBIsAbsences = b === sAbsences;

			if (bAIsAbsences || bBIsAbsences) {
				return bAIsAbsences === bBIsAbsences ? 0 : (bAIsAbsences ? 1 : -1);
			}
			return (a || "").localeCompare(b || "");
		},

		/* =========================================================== */
		/* data loading                                                */
		/* =========================================================== */

		/**
		 * Loads the resource directory that backs the "viewing as" picker. Only managers
		 * get to use it, but the list is cheap and stable so it is fetched once.
		 * Scoped to the signed-in manager's own direct reports (plus themselves) - not
		 * the whole org - so a manager can only view timesheets they are entitled to see.
		 * @returns {Promise} resolved once the directory is in the model
		 */
		_loadDirectory: function () {
			var sManagerId = CurrentUser.get() && CurrentUser.get().empID;

			return this._read("/Resources", {
				urlParameters: { "$select": "EmpID,FName,LName,Email,IsActive,ManagerID" },
				filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)]
			}).then(function (oData) {
				this.getModel("ts").setProperty("/directory", this._strip(oData)
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
				this._showError("tsErrorDirectory", oError);
			}.bind(this));
		},

		/**
		 * Loads the bookings of the week on screen and rebuilds the grid.
		 * @returns {Promise} resolved once the week is in the model
		 */
		_loadWeek: function () {
			var oViewModel = this.getModel("tsView");
			var oMonday = formatter.toDate(oViewModel.getProperty("/weekStart")) || this._mondayOf(new Date());
			var aDates = this._weekDates(oMonday);
			var sEmail = oViewModel.getProperty("/currentEmail");
			// 'gaurav.kumar@bluestonex.com';
			// var sorgid = 'BSX';

			oViewModel.setProperty("/busy", true);
			oViewModel.setProperty("/weekLabel", formatter.dateRange(aDates[0], aDates[6]));
			oViewModel.setProperty("/selectedCount", 0);

			return Promise.all([
				this._getJson(TIMESHEET_SERVICE + "?cmd=fetch&" + new URLSearchParams({
					Email: sEmail,
					FromDate: this._isoDate(aDates[0]),
					ToDate: this._isoDate(aDates[6]),
					OrgID: this._sOrgId
					// sorgid
				}).toString()),
				this._loadWorkSchedule(sEmail)
			]).then(function (aResults) {
				var oData = aResults[0];
				var oUser = oData.user || {};

				oViewModel.setProperty("/userId", oUser.empID || "");
				oViewModel.setProperty("/pic", oUser.pic || "");

				// Manager rights belong to whoever is signed in, not to the person being
				// viewed - otherwise opening a colleague's week would hide the picker that
				// gets you back.
				if (oViewModel.getProperty("/currentEmail") === this._sUserEmail) {
					oViewModel.setProperty("/isManager", oUser.isManager === "Y");
				}
				this._oWorkSchedule = aResults[1];
				this._oNonWorkingDates = this._nonWorkingDates(oData);

				this.getModel("ts").setProperty("/rows",
					this._defaultRows(this._buildRows(oData.assignments || [], aDates))
						.concat(this._buildNonWorkingRows(oData, aDates)));

				this._updateKpis(oUser, oData, aDates);
				this._recalculate();
				oViewModel.setProperty("/busy", false);
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/busy", false);
				this.getModel("ts").setProperty("/rows", []);
				this._recalculate();
				this._showError("tsErrorWeek", oError);
			}.bind(this));
		},

		/**
		 * Reads the resource's weekly work schedule straight from /Resources, rather than
		 * trusting whatever the timesheet fetch happens to echo back.
		 * @param {string} sEmail the resource whose schedule is being viewed
		 * @returns {Promise<object|null>} a day-name/flag map, or null when nothing was found
		 */
		_loadWorkSchedule: function (sEmail) {
			if (!sEmail) {
				return Promise.resolve(null);
			}

			return this._read("/Resources", {
				urlParameters: { "$select": "Email," + DAYS.map(function (oDay) { return oDay.abbrev; }).join(",") },
				filters: [
					new Filter("OrgID", FilterOperator.EQ, this._sOrgId),
					new Filter("Email", FilterOperator.EQ, sEmail)
				]
			}).then(function (oData) {
				var oResource = this._strip(oData)[0];
				if (!oResource) {
					return null;
				}

				var oSchedule = {};
				DAYS.forEach(function (oDay) {
					oSchedule[oDay.schedule] = oResource[oDay.abbrev];
				});
				return oSchedule;
			}.bind(this)).catch(function () {
				// A resource that isn't found, or a service hiccup, falls back to the
				// Mon-Fri default in _isWorkingDay rather than blocking the week from loading.
				return null;
			});
		},

		/**
		 * Turns the assignments and their time entries into one row per project, with a
		 * cell per day of the week.
		 * @param {Array<object>} aAssignments assignments returned by the service
		 * @param {Array<Date>} aDates the seven days of the week
		 * @returns {Array<object>} the grid rows
		 */
		_buildRows: function (aAssignments, aDates) {
			var mRows = {};

			aAssignments.forEach(function (oAssignment) {
				var sProjectId = oAssignment.ProjectID;
				if (mRows[sProjectId]) {
					return;
				}

				var iBillable = parseInt(oAssignment.BillableMins, 10) || 0;
				var iBilled = parseInt(oAssignment.TotalBilledMin, 10) || 0;

				mRows[sProjectId] = {
					ProjectID: sProjectId,
					project: oAssignment.ProjectDesc,
					ClientKey: oAssignment.ClientKey,
					ClientDesc: oAssignment.ClientDesc,
					PONo: formatter.clean(oAssignment.PONo),
					ProjectTypeText: oAssignment.ProjectTypeText,
					Billable: oAssignment.ProjectTypeText === "Billable",
					// Billable work booked beyond what the assignment allows for.
					Overbooked: oAssignment.ProjectTypeText === "Billable" && iBilled > iBillable,
					readOnly: false,
					// BlueStoneX's own projects are pinned to every sheet by _defaultRows
					// and are not the user's to remove, so they cannot be selected.
					deletable: oAssignment.ClientKey !== INTERNAL_CLIENT,
					days: this._buildDays(aDates)
				};
			}, this);

			// Time entries can arrive on any assignment row of the same project.
			aAssignments.forEach(function (oAssignment) {
				var oRow = mRows[oAssignment.ProjectID];
				var aEntries = oAssignment.TimeEntries;
				if (!oRow || !aEntries || !aEntries.length) {
					return;
				}

				aEntries.forEach(function (oEntry) {
					var iIndex = this._dayIndexOf(oEntry.Date, aDates);
					if (iIndex === -1) {
						return;
					}

					var oDay = oRow.days[iIndex];
					var sHours = this._trimSeconds(oEntry.Hours);

					oDay.recId = oEntry.RecID || "";
					oDay.time = sHours === "00:00" ? "" : sHours;
					oDay.comment = formatter.clean(oEntry.Comment);
					oDay.serviceTime = oDay.time;
					oDay.serviceComment = oDay.comment;
				}, this);
			}, this);

			return Object.keys(mRows).map(function (sKey) {
				return mRows[sKey];
			}).sort(function (a, b) {
				return (a.project || "").localeCompare(b.project || "");
			});
		},

		/**
		 * A week starts with internal work only - a consultant is assigned to far more
		 * client projects than they book against in any one week, so the rest are added
		 * on demand. Anything already booked stays on the sheet regardless.
		 * @param {Array<object>} aRows every row the assignments produced
		 * @returns {Array<object>} the rows to show by default
		 */
		_defaultRows: function (aRows) {
			return aRows.filter(function (oRow) {
				if (oRow.ClientKey === INTERNAL_CLIENT) {
					return true;
				}
				return oRow.days.some(function (oDay) {
					return !!oDay.time;
				});
			});
		},

		/**
		 * Leave and bank holidays are shown as read-only rows so the week total reflects
		 * them, exactly as the standalone app did.
		 * @param {object} oData the service response
		 * @param {Array<Date>} aDates the seven days of the week
		 * @returns {Array<object>} the non-working rows
		 */
		_buildNonWorkingRows: function (oData, aDates) {
			var aRows = [];

			[
				{ key: "bankHolidays", label: this.getText("tsBankHoliday") },
				{ key: "leaves", label: this.getText("tsLeave") }
			].forEach(function (oSource) {
				var aEntries = oSource.key === "leaves"
					? Backend.countedLeaves(oData.leaves)
					: (oData[oSource.key] || []);
				if (!aEntries.length) {
					return;
				}

				var oRow = {
					ProjectID: "NONWORK_" + oSource.key,
					project: oSource.label,
					ClientKey: "",
					// The grid groups by client, so absences need a group of their own.
					ClientDesc: this.getText("tsAbsences"),
					PONo: "",
					ProjectTypeText: "",
					Billable: false,
					Overbooked: false,
					readOnly: true,
					deletable: false,
					days: this._buildDays(aDates)
				};

				// Nothing on a leave or bank holiday row is bookable.
				oRow.days.forEach(function (oDay) {
					oDay.editable = false;
				});

				aEntries.forEach(function (oEntry) {
					var iIndex = this._dayIndexOf(oEntry.Date, aDates);
					if (iIndex === -1) {
						return;
					}
					var sHours = this._trimSeconds(oEntry.Hours);
					oRow.days[iIndex].time = sHours === "00:00" ? "" : sHours;
				}, this);

				aRows.push(oRow);
			}, this);

			return aRows;
		},

		_buildDays: function (aDates) {
			var mNonWorkingDates = this._oNonWorkingDates || {};

			return DAYS.map(function (oDay, iIndex) {
				var oDate = aDates[iIndex];
				var sIsoDate = this._isoDate(oDate);
				return {
					key: oDay.key,
					date: sIsoDate,
					time: "",
					comment: "",
					recId: "",
					serviceTime: "",
					serviceComment: "",
					working: this._isWorkingDay(oDay.schedule),
					// A project row's own cell is locked on any day that is fully covered by
					// leave or a bank holiday, same as the dedicated absence rows, and on any
					// day the user's work schedule doesn't flag "Y".
					editable: this._isWorkingDay(oDay.schedule) && this._isOpenForBooking(oDate) && !mNonWorkingDates[sIsoDate]
				};
			}, this);
		},

		/**
		 * @param {object} oData the service response
		 * @returns {object} a set of this week's leave/bank-holiday dates, keyed by ISO date
		 */
		_nonWorkingDates: function (oData) {
			var mDates = {};

			Backend.countedLeaves(oData.leaves).concat(oData.bankHolidays || []).forEach(function (oEntry) {
				mDates[String(oEntry.Date).slice(0, 10)] = true;
			});

			return mDates;
		},

		/**
		 * A day can be booked while its month is still open. A closed month stays open
		 * for corrections during the first few working days of the following month.
		 * @param {Date} oDate the day in question
		 * @returns {boolean} true when the day may still be edited
		 */
		_isOpenForBooking: function (oDate) {
			var oToday = new Date();
			var iMonthsBack = (oToday.getFullYear() - oDate.getFullYear()) * 12 + (oToday.getMonth() - oDate.getMonth());

			if (iMonthsBack <= 0) {
				return true;
			}
			if (iMonthsBack > 1) {
				return false;
			}
			return this._workingDaysSoFar(oToday) <= GRACE_WORKING_DAYS;
		},

		/**
		 * @param {Date} oToday today
		 * @returns {number} how many working days of the current month have passed
		 */
		_workingDaysSoFar: function (oToday) {
			var iWorkingDays = 0;
			for (var iDay = 1; iDay <= oToday.getDate(); iDay++) {
				var oDate = new Date(oToday.getFullYear(), oToday.getMonth(), iDay);
				var iWeekday = oDate.getDay();
				if (iWeekday !== 0 && iWeekday !== 6) {
					iWorkingDays++;
				}
			}
			return iWorkingDays;
		},

		_isWorkingDay: function (sScheduleKey) {
			if (!this._oWorkSchedule) {
				return sScheduleKey !== "Saturday" && sScheduleKey !== "Sunday";
			}
			return this._oWorkSchedule[sScheduleKey] !== "N";
		},

		/**
		 * Fills the header figures from the user block of the response.
		 * @param {object} oUser the user block
		 * @param {object} oData the whole response
		 * @param {Array<Date>} aDates the seven days of the week
		 */
		_updateKpis: function (oUser, oData, aDates) {
			var oViewModel = this.getModel("tsView");

			var fTargetDays = parseFloat(oUser.utilizationTargetDays) || 0;
			var fActualDays = parseFloat(oUser.CurrentMonthActualBilledDays) || 0;
			var iWorkingDays = parseInt(oUser.noOfWorkingDays, 10) || 0;
			var fUtilisation = iWorkingDays ? Math.round(fActualDays * 1000 / iWorkingDays) / 10 : 0;

			// Leave and bank holidays in this week reduce the hours the user owes.
			var iTargetMinutes = this._toMinutes(oUser.targetHrsPerWeek);
			iTargetMinutes -= Backend.countedLeaves(oData.leaves).reduce(function (iTotal, oEntry) {
				return iTotal + this._toMinutes(oEntry.Hours);
			}.bind(this), 0);
			iTargetMinutes -= (oData.bankHolidays || []).filter(function (oEntry) {
				return oEntry.Day !== "Saturday" && oEntry.Day !== "Sunday";
			}).reduce(function (iTotal, oEntry) {
				return iTotal + this._toMinutes(oEntry.Hours);
			}.bind(this), 0);

			this._iWeekTargetMinutes = Math.max(iTargetMinutes, 0);

			oViewModel.setProperty("/kpis", {
				targetDays: fTargetDays,
				actualDays: fActualDays,
				actualState: fActualDays >= fTargetDays ? "Good" : "Critical",
				utilisation: fUtilisation,
				month: aDates[0].toLocaleDateString("en-GB", { month: "long", year: "numeric" })
			});
		},

		/**
		 * Recomputes the per-day and weekly totals shown in the header and column titles.
		 */
		_recalculate: function () {
			var oViewModel = this.getModel("tsView");
			var aRows = this.getModel("ts").getProperty("/rows") || [];
			var oMonday = formatter.toDate(oViewModel.getProperty("/weekStart")) || this._mondayOf(new Date());
			var aDates = this._weekDates(oMonday);

			// Leave and bank holidays already reduce the weekly target, so counting them
			// as booked time as well would double up.
			var aBookableRows = aRows.filter(function (oRow) {
				return !oRow.readOnly;
			});

			var aHeaders = DAYS.map(function (oDay, iIndex) {
				var iMinutes = aBookableRows.reduce(function (iTotal, oRow) {
					return iTotal + this._toMinutes(oRow.days[iIndex].time);
				}.bind(this), 0);

				return {
					label: oDay.label,
					date: aDates[iIndex].getDate() + " " + aDates[iIndex].toLocaleDateString("en-GB", { month: "short" }),
					total: this._fromMinutes(iMinutes),
					working: this._isWorkingDay(oDay.schedule)
				};
			}, this);

			var iBooked = aHeaders.reduce(function (iTotal, oHeader) {
				return iTotal + this._toMinutes(oHeader.total);
			}.bind(this), 0);
			var iTarget = this._iWeekTargetMinutes || 0;

			oViewModel.setProperty("/dayHeaders", aHeaders);
			oViewModel.setProperty("/weekBooked", this._fromMinutes(iBooked));
			oViewModel.setProperty("/weekTarget", this._fromMinutes(iTarget));
			oViewModel.setProperty("/weekPercent", iTarget ? Math.min(Math.round(iBooked * 100 / iTarget), 100) : 0);
		},

		/* =========================================================== */
		/* week navigation                                             */
		/* =========================================================== */

		onPreviousWeek: function () {
			this._stepWeek(-7);
		},

		onNextWeek: function () {
			this._stepWeek(7);
		},

		onCurrentWeek: function () {
			this.getModel("tsView").setProperty("/weekStart", this._mondayOf(new Date()));
			this._loadWeek();
		},

		_stepWeek: function (iDays) {
			var oViewModel = this.getModel("tsView");
			var oMonday = formatter.toDate(oViewModel.getProperty("/weekStart")) || this._mondayOf(new Date());
			var oNext = new Date(oMonday.getFullYear(), oMonday.getMonth(), oMonday.getDate() + iDays);

			oViewModel.setProperty("/weekStart", oNext);
			this._loadWeek();
		},

		onOpenWeekPicker: function (oEvent) {
			var oButton = oEvent.getSource();

			this._openPopover("_pWeekPicker", "bsx.hrx.hrx2026.fragment.WeekPickerPopover", oButton).then(function () {
				var oCalendar = this.byId("weekPickerCalendar");
				if (oCalendar) {
					oCalendar.removeAllSelectedDates();
					oCalendar.focusDate(formatter.toDate(this.getModel("tsView").getProperty("/weekStart")));
				}
			}.bind(this));
		},

		onWeekPicked: function (oEvent) {
			var aSelected = oEvent.getSource().getSelectedDates();
			var oDate = aSelected.length && aSelected[0].getStartDate();
			if (!oDate) {
				return;
			}

			this.getModel("tsView").setProperty("/weekStart", this._mondayOf(oDate));
			this._closePopover("_pWeekPicker");
			this._loadWeek();
		},

		onViewAsChange: function (oEvent) {
			var sEmail = oEvent.getSource().getSelectedKey();
			if (!sEmail) {
				// The picker has been cleared. Nothing to load, and the week already on
				// screen still belongs to _sViewAsEmail, so leave it be - onRefresh is
				// where an empty picker gets answered.
				return;
			}
			this._sViewAsEmail = sEmail;
			this.getModel("tsView").setProperty("/currentEmail", sEmail);
			this._loadWeek();
		},

		/**
		 * Reloads the week on screen. Clearing the "viewing as" picker leaves no user to
		 * load, so rather than silently reloading whoever was there before - or asking
		 * the service for an empty Email, which matches everybody - say what is missing
		 * and put the last valid person back.
		 */
		onRefresh: function () {
			var oViewModel = this.getModel("tsView");
			var oViewAs = this.byId("timesheetViewAs");

			if (oViewModel.getProperty("/isManager") && oViewAs && !oViewAs.getSelectedKey()) {
				MessageBox.information(this.getText("tsSelectUser"));
				this._restoreViewAs();
			}

			this._loadWeek();
		},

		/**
		 * Puts the "viewing as" picker back to the last person actually chosen, falling
		 * back to whoever is signed in.
		 */
		_restoreViewAs: function () {
			var sEmail = this._sViewAsEmail || this._sUserEmail;
			var oViewAs = this.byId("timesheetViewAs");

			this.getModel("tsView").setProperty("/currentEmail", sEmail);
			if (oViewAs) {
				// setSelectedKey alone leaves the typed-into text box empty, so the name
				// is written back from the directory entry as well.
				oViewAs.setSelectedKey(sEmail);
				oViewAs.setValue(this._viewAsName(sEmail));
				oViewAs.setValueState("None");
			}
		},

		/**
		 * @param {string} sEmail the resource's email
		 * @returns {string} that resource's name from the directory, or the email itself
		 */
		_viewAsName: function (sEmail) {
			var aDirectory = this.getModel("ts").getProperty("/directory") || [];
			var oMatch = aDirectory.filter(function (oResource) {
				return oResource.Email === sEmail;
			})[0];
			return (oMatch && oMatch.FullName) || sEmail;
		},

		/* =========================================================== */
		/* time entry                                                  */
		/* =========================================================== */

		/**
		 * Normalises whatever the user typed into hh:mm and refreshes the totals.
		 * @param {sap.ui.base.Event} oEvent the input change event
		 */
		onTimeChange: function (oEvent) {
			var oInput = oEvent.getSource();
			var oContext = oInput.getBindingContext("ts");
			if (!oContext) {
				return;
			}

			var sValue = (oInput.getValue() || "").trim();
			var sNormalised = this._normaliseTime(sValue);

			if (sValue && sNormalised === null) {
				oInput.setValueState("Error");
				oInput.setValueStateText(this.getText("tsInvalidTime"));
				return;
			}

			oInput.setValueState("None");
			this.getModel("ts").setProperty(oContext.getPath() + "/time", sNormalised || "");
			this._recalculate();
		},

		/**
		 * Accepts "7", "7:30", "7.5" or "730" and returns hh:mm.
		 * @param {string} sValue whatever was typed
		 * @returns {string|null} the normalised time, or null when it cannot be read
		 */
		_normaliseTime: function (sValue) {
			if (!sValue) {
				return "";
			}

			var aParts = /^(\d{1,2}):(\d{1,2})$/.exec(sValue);
			var iHours;
			var iMinutes;

			if (aParts) {
				iHours = parseInt(aParts[1], 10);
				iMinutes = parseInt(aParts[2], 10);
			} else if (/^\d{1,2}([.,]\d{1,2})?$/.test(sValue)) {
				var fValue = parseFloat(sValue.replace(",", "."));
				iHours = Math.floor(fValue);
				iMinutes = Math.round((fValue - iHours) * 60);
			} else if (/^\d{3,4}$/.test(sValue)) {
				iHours = parseInt(sValue.slice(0, sValue.length - 2), 10);
				iMinutes = parseInt(sValue.slice(-2), 10);
			} else {
				return null;
			}

			if (isNaN(iHours) || isNaN(iMinutes) || iMinutes > 59 || iHours > 24 || (iHours === 24 && iMinutes > 0)) {
				return null;
			}

			return String(iHours).padStart(2, "0") + ":" + String(iMinutes).padStart(2, "0");
		},

		/**
		 * Opens the work description for one cell.
		 * @param {sap.ui.base.Event} oEvent the button press event
		 */
		onOpenComment: function (oEvent) {
			var oButton = oEvent.getSource();
			var oContext = oButton.getBindingContext("ts");
			if (!oContext) {
				return;
			}

			var oDay = oContext.getObject();
			var oRow = this.getModel("ts").getProperty(oContext.getPath().replace(/\/days\/\d+$/, ""));

			this._sCommentPath = oContext.getPath();
			this.getModel("tsComment").setData({
				comment: oDay.comment || "",
				label: oRow.project + " — " + formatter.date(oDay.date),
				editable: oDay.editable && !oRow.readOnly
			});

			this._openPopover("_pCommentPopover", "bsx.hrx.hrx2026.fragment.CommentPopover", oButton);
		},

		/**
		 * Writes the description back onto the cell when the popover closes.
		 */
		onCommentClosed: function () {
			if (!this._sCommentPath) {
				return;
			}
			this.getModel("ts").setProperty(this._sCommentPath + "/comment",
				this.getModel("tsComment").getProperty("/comment") || "");
			this._sCommentPath = null;
		},

		/**
		 * Keeps the selection to rows that may actually be deleted. sap.m.Table has no
		 * per-row switch for this, and its checkbox is hidden by CSS for the rest, but
		 * "select all" still reaches them - so anything not deletable is dropped again
		 * here before the count that enables the Delete button is taken.
		 * @param {sap.ui.base.Event} oEvent the selectionChange event
		 */
		onSelectionChange: function (oEvent) {
			var oTable = oEvent.getSource();
			var bRefused = false;

			oTable.getSelectedItems().forEach(function (oItem) {
				var oContext = oItem.getBindingContext("ts");
				var oRow = oContext && oContext.getObject();
				if (oRow && oRow.deletable === false) {
					oTable.setSelectedItem(oItem, false);
					bRefused = true;
				}
			});

			// if (bRefused) {
			// 	MessageToast.show(this.getText("tsRowNotDeletable"));
			// }

			this.getModel("tsView").setProperty("/selectedCount", oTable.getSelectedItems().length);
		},

		/**
		 * Drops every tick in the grid and the count behind the Delete button.
		 * selectionChange does not fire for a programmatic clear, so the count has to
		 * be put back by hand.
		 */
		_clearTableSelection: function () {
			var oTable = this.byId("timesheetTable");
			if (oTable) {
				oTable.removeSelections(true);
			}
			this.getModel("tsView").setProperty("/selectedCount", 0);
		},

		/* =========================================================== */
		/* add and remove projects                                     */
		/* =========================================================== */

		/**
		 * Offers the assignments that are not on the timesheet yet.
		 */
		onOpenAddProjects: function () {
			var oViewModel = this.getModel("tsView");
			var aDates = this._weekDates(formatter.toDate(oViewModel.getProperty("/weekStart")));
			// var smail = 'gaurav.kumar@bluestonex.com';
			// var sorgid = 'BSX';

			oViewModel.setProperty("/saving", true);

			this._getJson(TIMESHEET_SERVICE + "?cmd=fetchAssignments&" + new URLSearchParams({
				Email: oViewModel.getProperty("/currentEmail"),
				// smail,
				FromDate: this._isoDate(aDates[0]),
				ToDate: this._isoDate(aDates[6]),
				OrgID: this._sOrgId
				// sorgid
			}).toString()).then(function (oData) {
				var aExisting = (this.getModel("ts").getProperty("/rows") || []).map(function (oRow) {
					return oRow.ProjectID;
				});

				var mSeen = {};
				var aAvailable = (oData.assignments || []).filter(function (oAssignment) {
					if (aExisting.indexOf(oAssignment.ProjectID) !== -1 || mSeen[oAssignment.ProjectID]) {
						return false;
					}
					mSeen[oAssignment.ProjectID] = true;
					return true;
				}).sort(function (a, b) {
					return (a.ProjectDesc || "").localeCompare(b.ProjectDesc || "");
				});

				this.getModel("ts").setProperty("/available", aAvailable);
				oViewModel.setProperty("/saving", false);
				return this._openDialog("_pAddProjectsDialog", "bsx.hrx.hrx2026.fragment.AddTimesheetProjectsDialog");
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/saving", false);
				this._showError("tsErrorAssignments", oError);
			}.bind(this));
		},

		onCancelAddProjects: function () {
			this._closeDialog("_pAddProjectsDialog");
		},

		onConfirmAddProjects: function () {
			var oTable = this.byId("addProjectsTable");
			var aSelected = oTable ? oTable.getSelectedItems() : [];

			if (!aSelected.length) {
				MessageToast.show(this.getText("tsSelectProject"));
				return;
			}

			var aDates = this._weekDates(formatter.toDate(this.getModel("tsView").getProperty("/weekStart")));
			var aRows = this.getModel("ts").getProperty("/rows") || [];

			aSelected.forEach(function (oItem) {
				var oAssignment = oItem.getBindingContext("ts").getObject();
				aRows.push({
					ProjectID: oAssignment.ProjectID,
					project: oAssignment.ProjectDesc,
					ClientKey: oAssignment.ClientKey,
					ClientDesc: oAssignment.ClientDesc,
					PONo: formatter.clean(oAssignment.PONo),
					ProjectTypeText: oAssignment.ProjectTypeText,
					Billable: oAssignment.ProjectTypeText === "Billable",
					Overbooked: false,
					readOnly: false,
					deletable: oAssignment.ClientKey !== INTERNAL_CLIENT,
					days: this._buildDays(aDates)
				});
			}, this);

			// Leave and bank holiday rows are read-only and must stay pinned to the
			// bottom of the list, so only the bookable project rows are re-sorted.
			var aBookable = aRows.filter(function (oRow) {
				return !oRow.readOnly;
			});
			var aNonWorking = aRows.filter(function (oRow) {
				return oRow.readOnly;
			});

			aBookable.sort(function (a, b) {
				return (a.project || "").localeCompare(b.project || "");
			});

			this.getModel("ts").setProperty("/rows", aBookable.concat(aNonWorking));
			oTable.removeSelections(true);
			this._closeDialog("_pAddProjectsDialog");
			this._recalculate();
		},

		/**
		 * Removes the selected rows. Anything already stored is deleted on the backend
		 * first; rows that were only added on screen simply disappear.
		 */
		onDeleteProjects: function () {
			var oTable = this.byId("timesheetTable");
			var aSelected = oTable ? oTable.getSelectedItems() : [];

			if (!aSelected.length) {
				MessageToast.show(this.getText("tsSelectRow"));
				return;
			}

			var aRows = this.getModel("ts").getProperty("/rows") || [];
			var aSelectedRows = aSelected.map(function (oItem) {
				return oItem.getBindingContext("ts").getObject();
			}).filter(function (oRow) {
				// onSelectionChange already refuses these, so this only guards against a
				// selection set some other way - but deleting one must never be possible.
				return oRow.deletable !== false;
			});

			if (!aSelectedRows.length) {
				MessageToast.show(this.getText("tsRowNotDeletable"));
				return;
			}
			var aNames = aSelectedRows.map(function (oRow) {
				return oRow.project;
			}).join(", ");

			MessageBox.confirm(this.getText("tsConfirmDelete", [aNames]), {
				title: this.getText("tsConfirmDeleteTitle"),
				icon: MessageBox.Icon.WARNING,
				emphasizedAction: MessageBox.Action.CANCEL,
				onClose: function (sAction) {
					if (sAction !== MessageBox.Action.OK) {
						return;
					}

					var aRecIds = [];
					aSelectedRows.forEach(function (oRow) {
						oRow.days.forEach(function (oDay) {
							if (oDay.recId) {
								aRecIds.push({ RecID: oDay.recId });
							}
						});
					});

					var aRemaining = aRows.filter(function (oRow) {
						return aSelectedRows.indexOf(oRow) === -1;
					});

					var fnFinish = function () {
						this.getModel("ts").setProperty("/rows", aRemaining);
						this._clearTableSelection();
						this._recalculate();
					}.bind(this);

					if (!aRecIds.length) {
						fnFinish();
						return;
					}

					// Rows carrying booked time go through the service and come back via
					// _loadWeek. That rebuilds the rows but leaves the table's own
					// selection behind, so the ticks - and the count that enables the
					// Delete button - have to be cleared here as well, on the way out
					// whether the delete succeeded or not.
					this._save(TIMESHEET_SERVICE + "?cmd=delete", {
						OrgID: this._sOrgId,
						UserID: this.getModel("tsView").getProperty("/userId"),
						TimesheetListSet: aRecIds
					}, "tsDeleted", "tsErrorDelete").then(function () {
						return this._loadWeek();
					}.bind(this)).catch(function () { /* reported by _save */ })
						.then(this._clearTableSelection.bind(this));
				}.bind(this)
			});
		},

		/* =========================================================== */
		/* save                                                        */
		/* =========================================================== */

		/**
		 * Saves every cell that was booked or cleared this session. A booking without a
		 * work description is rejected - managers rely on those to see what was worked on.
		 */
		onSave: function () {
			var oViewModel = this.getModel("tsView");
			var aRows = this.getModel("ts").getProperty("/rows") || [];
			var aEntries = [];
			var bCommentMissing = false;

			aRows.forEach(function (oRow) {
				if (oRow.readOnly) {
					return;
				}

				oRow.days.forEach(function (oDay) {
					var bBooked = !!oDay.time && oDay.time !== "00:00";
					var bCleared = !oDay.time && !!oDay.serviceTime;

					if (bBooked && this._needsComment(oRow) && !oDay.comment) {
						bCommentMissing = true;
						return;
					}

					if (oDay.time) {
						aEntries.push({
							RecID: oDay.recId || "",
							ProjectKey: oRow.ProjectID,
							Date: oDay.date,
							Hours: oDay.time + ":00",
							Comment: oDay.comment || ""
						});
					} else if (bCleared) {
						aEntries.push({
							RecID: oDay.recId || "",
							ProjectKey: oRow.ProjectID,
							Date: oDay.date,
							Hours: "00:00:00",
							Comment: ""
						});
					}
				}, this);
			}, this);

			if (bCommentMissing) {
				MessageBox.error(this.getText("tsErrorCommentMissing"));
				return;
			}
			if (!aEntries.length) {
				MessageToast.show(this.getText("tsNothingToSave"));
				return;
			}

			var oNow = new Date();

			this._save(TIMESHEET_SERVICE + "?cmd=save", {
				OrgID: this._sOrgId,
				UserID: oViewModel.getProperty("/userId"),
				SavedOn: this._isoDate(oNow),
				SavedAt: this._clockTime(oNow),
				SavedBy: oViewModel.getProperty("/userId"),
				TimesheetListSet: aEntries
			}, "tsSaved", "tsErrorSave").then(function () {
				return this._loadWeek();
			}.bind(this)).catch(function () { /* reported by _save */ });
		},

		/**
		 * @param {object} oRow a grid row
		 * @returns {boolean} true when bookings on this row need a work description
		 */
		_needsComment: function (oRow) {
			return !oRow.readOnly && oRow.ClientKey !== NO_COMMENT_CLIENT;
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
			var oViewModel = this.getModel("tsView");
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
			return this._loadFragment(sCacheKey, sFragmentName).then(function (oDialog) {
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

		_openPopover: function (sCacheKey, sFragmentName, oBy) {
			return this._loadFragment(sCacheKey, sFragmentName).then(function (oPopover) {
				oPopover.openBy(oBy);
				return oPopover;
			});
		},

		_closePopover: function (sCacheKey) {
			if (this[sCacheKey]) {
				this[sCacheKey].then(function (oPopover) {
					oPopover.close();
				});
			}
		},

		_loadFragment: function (sCacheKey, sFragmentName) {
			if (!this[sCacheKey]) {
				this[sCacheKey] = Fragment.load({
					id: this.getView().getId(),
					name: sFragmentName,
					controller: this
				}).then(function (oControl) {
					this.getView().addDependent(oControl);
					return oControl;
				}.bind(this));
			}
			return this[sCacheKey];
		},

		_strip: function (oData) {
			return (oData.results || []).map(function (oRow) {
				var oCopy = Object.assign({}, oRow);
				delete oCopy.__metadata;
				return oCopy;
			});
		},

		/**
		 * @param {Date} oDate any day
		 * @returns {Date} the Monday of that day's week
		 */
		_mondayOf: function (oDate) {
			var oCopy = new Date(oDate.getFullYear(), oDate.getMonth(), oDate.getDate());
			var iOffset = (oCopy.getDay() + 6) % 7;
			oCopy.setDate(oCopy.getDate() - iOffset);
			return oCopy;
		},

		_weekDates: function (oMonday) {
			return DAYS.map(function (oDay, iIndex) {
				return new Date(oMonday.getFullYear(), oMonday.getMonth(), oMonday.getDate() + iIndex);
			});
		},

		_dayIndexOf: function (sDate, aDates) {
			for (var iIndex = 0; iIndex < aDates.length; iIndex++) {
				if (this._isoDate(aDates[iIndex]) === String(sDate).slice(0, 10)) {
					return iIndex;
				}
			}
			return -1;
		},

		/**
		 * Durations arrive either as hh:mm:ss or already as hh:mm, so only a third part
		 * may be dropped - trimming unconditionally would eat the minutes.
		 * @param {string} sHours a duration
		 * @returns {string} the duration as hh:mm
		 */
		_trimSeconds: function (sHours) {
			if (!sHours || sHours === "None") {
				return "";
			}
			var aParts = String(sHours).split(":");
			return aParts.length > 2 ? aParts[0] + ":" + aParts[1] : String(sHours);
		},

		_toMinutes: function (sTime) {
			if (!sTime) {
				return 0;
			}
			var aParts = String(sTime).split(":");
			return (parseInt(aParts[0], 10) || 0) * 60 + (parseInt(aParts[1], 10) || 0);
		},

		_fromMinutes: function (iMinutes) {
			return Math.floor(iMinutes / 60) + ":" + String(iMinutes % 60).padStart(2, "0");
		},

		/**
		 * @param {Date} oDate a moment
		 * @returns {string} the time as hh:mm:ss, zero padded
		 */
		_clockTime: function (oDate) {
			return [oDate.getHours(), oDate.getMinutes(), oDate.getSeconds()].map(function (iPart) {
				return String(iPart).padStart(2, "0");
			}).join(":");
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

		_emptyKpis: function () {
			return { targetDays: 0, actualDays: 0, actualState: "Neutral", utilisation: 0, month: "" };
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
