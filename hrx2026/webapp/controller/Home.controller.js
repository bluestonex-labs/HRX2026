sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/m/MessageToast",
	"sap/m/MessageBox",
	"../model/Backend",
	"../model/formatter",
	"../model/CurrentUser"
], function (Controller, JSONModel, Filter, FilterOperator, MessageToast, MessageBox,
	Backend, formatter, CurrentUser) {
	"use strict";

	// RadialMicroChart only accepts its own colour enum (a raw CSS colour has been
	// deprecated since 1.135), and its four semantic values are already spoken for:
	// Good = complete, Critical = action needed, Error = missing, Neutral = on
	// leave / not due yet. Sequence1 is the one slot carrying no meaning of its
	// own, so overbooked days claim it and style.css restyles it to the HRX
	// overbooked violet.
	var RING_OVERBOOKED = "Sequence1";

	// abbrev matches the day fields exposed by the /Resources OData entity.
	var DAYS = [
		{ label: "Mon", schedule: "Monday", abbrev: "Mo" },
		{ label: "Tue", schedule: "Tuesday", abbrev: "Tu" },
		{ label: "Wed", schedule: "Wednesday", abbrev: "We" },
		{ label: "Thu", schedule: "Thursday", abbrev: "Th" },
		{ label: "Fri", schedule: "Friday", abbrev: "Fr" },
		{ label: "Sat", schedule: "Saturday", abbrev: "Sa" },
		{ label: "Sun", schedule: "Sunday", abbrev: "Su" }
	];

	return Controller.extend("bsx.hrx.hrx2026.controller.Home", {

		formatter: formatter,

		/* =========================================================== */
		/* lifecycle                                                   */
		/* =========================================================== */

		onInit: function () {
			// Deliberately no service call here: the signed-in user is still being
			// resolved at this point, and asking a service for an empty Email does not
			// mean "nobody", it means "match anybody". Everything waits on the profile
			// in _onRouteMatched instead.
			this._sOrgId = CurrentUser.orgId(this.getOwnerComponent());
			this._sUserEmail = "";
			this.getView().setModel(new JSONModel(this._emptyState()), "home");

			this.getOwnerComponent().getRouter().getRoute("home")
				.attachPatternMatched(this._onRouteMatched, this);
		},


		/**
		 * The view is reused across navigations, so every entry comes back to today with
		 * fresh figures.
		 */
		_onRouteMatched: function () {
			var oModel = this.getModel();
			oModel.setProperty("/quick", this._emptyQuickEntry());
			oModel.setProperty("/quickLeave", this._emptyQuickLeave());

			var oDateRange = this.byId("qlDateRange");
			if (oDateRange) {
				oDateRange.setValue("");
				oDateRange.setValueState("None");
			}

			var oComponent = this.getOwnerComponent();

			// Component.init already resolved this, and it is built never to reject.
			// Asking _getLoggedinUserEmail() again here fetched /user-api/currentUser a
			// second time, which 404s with no approuter in front of a local run and
			// rejected the whole chain - taking the week, the day and the approvals
			// down with it.
			CurrentUser.ready(oComponent).then(function (oProfile) {
				this._oProfile = oProfile;
				this._sUserEmail = oProfile.email;
				this._sOrgId = oProfile.orgId;
				this._pWorkScheduleLoaded = this._loadWorkSchedule(oProfile.email);

				if (!oProfile.email) {
					// Nobody to load anything for. Say so rather than firing service
					// calls that would match everybody.
					oModel.setProperty("/weekRings", []);
					oModel.setProperty("/approvals", []);
					if (CurrentUser.shouldReportMissingIdentity()) {
						this._showError("homeErrorNoIdentity", null);
					}
					return;
				}

				this._loadLeaveTypes();
				this._loadDay();

				// Approvals are loaded for everybody, not only for a profile the team
				// service happened to flag as a manager: that flag went missing often
				// enough that the home page showed nothing while the same requests were
				// sitting in the team calendar. The card shows itself once there is
				// something in it (see the view), so a non-manager still sees nothing.
				Promise.all([
					this._loadWeek(),
					this._loadLeaveUser(),
					this._loadApprovals()
				]).then(function () {
					this._updateHealthStrip();
				}.bind(this));
			}.bind(this)).catch(function (oError) {
				// Spell the reason out: the rejection is often a plain response object,
				// which logs as an empty second argument and says nothing.
				console.error("Home _onRouteMatched failed",
					(oError && (oError.stack || oError.message)) || oError, oError);
			});
		},

		/**
		 * Reloads everything on the page. Called by the shell bar's reload button, which
		 * now serves whichever page is on screen.
		 * @returns {Promise} resolved once the page has been refilled
		 */
		onRefresh: function () {
			if (!this._sUserEmail) {
				return Promise.resolve();
			}

			return Promise.all([
				this._loadWeek(),
				this._loadDay(),
				this._loadLeaveUser(),
				this._loadApprovals()
			]).then(function () {
				this._updateHealthStrip();
			}.bind(this));
		},

		_weekDates: function (oMonday) {
			return DAYS.map(function (oDay, iIndex) {
				return new Date(oMonday.getFullYear(), oMonday.getMonth(), oMonday.getDate() + iIndex);
			});
		},

		/* =========================================================== */
		/* data loading                                                */
		/* =========================================================== */

		/**
		 * Leave types back the Quick Leave picker. They are stable, so they are read once
		 * per visit straight from the OData service.
		 * @returns {Promise} resolved once the types are in the model
		 */
		_loadLeaveTypes: function () {
			if (this.getModel().getProperty("/leaveTypes").length) {
				return Promise.resolve();
			}

			// Backend.read, not a bare model.read: it waits for the service metadata,
			// including the retries Component.js makes after a failed first attempt. A
			// momentary outage at startup used to leave this picker empty - "no data" -
			// for the rest of the session with nothing on screen to say why.
			return Backend.read(this.getOwnerComponent().getModel(), "/LeaveTypes", {
				filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)]
			}).then(function (oData) {
				this.getModel().setProperty("/leaveTypes", (oData.results || []).map(function (oType) {
					return {
						LeaveCategoryId: oType.LeaveCategoryId,
						LeaveCategoryDesc: oType.LeaveCategoryDesc
					};
				}));
			}.bind(this)).catch(function (oError) {
				this.getModel().setProperty("/leaveTypes", []);
				this._showError("mlErrorLookups", oError);
			}.bind(this));
		},

		_mondayOf: function (oDate) {
			var oCopy = new Date(oDate.getFullYear(), oDate.getMonth(), oDate.getDate());
			var iOffset = (oCopy.getDay() + 6) % 7;
			oCopy.setDate(oCopy.getDate() - iOffset);
			return oCopy;
		},

		/**
		 * The leave block carries the approver and the remaining balance the Quick Leave
		 * card needs.
		 * @returns {Promise} resolved once the block is in the model
		 */
		_loadLeaveUser: function () {
			return Backend.getJson(Backend.query(Backend.LEAVE, {
				cmd: "fetchUser",
				Email: this._sUserEmail,
				OrgID: this._sOrgId
			})).then(function (oData) {
				var oUser = oData.user || {};
				// The picture arrives as a large data url and nothing here shows it.
				delete oUser.pic;
				this.getModel().setProperty("/user", oUser);
			}.bind(this)).catch(function (oError) {
				this._showError("homeErrorLeaveUser", oError);
			}.bind(this));
		},

		/**
		 * Reads the signed-in user's weekly work schedule straight from /Resources, rather
		 * than trusting whatever the timesheet fetch happens to echo back.
		 * @param {string} sEmail the signed-in user's email
		 * @returns {Promise} resolved once this._oWorkSchedule is filled
		 */
		_loadWorkSchedule: function (sEmail) {
			if (!sEmail) {
				// No signed-in identity to filter on - e.g. a BAS preview with no
				// approuter session. Every resource has a real email, so this query
				// would only ever come back empty; skip it rather than send a doomed
				// request that can take the rest of the batch down with it.
				this._oWorkSchedule = {};
				return Promise.resolve();
			}

			return Backend.read(this.getOwnerComponent().getModel(), "/Resources", {
				urlParameters: { "$select": "Email," + DAYS.map(function (oDay) { return oDay.abbrev; }).join(",") },
				filters: [
					new Filter("OrgID", FilterOperator.EQ, this._sOrgId),
					new Filter("Email", FilterOperator.EQ, sEmail)
				]
			}).then(function (oData) {
				var oResource = (oData.results || [])[0];
				this._oWorkSchedule = DAYS.reduce(function (oSchedule, oDay) {
					oSchedule[oDay.schedule] = oResource && oResource[oDay.abbrev];
					return oSchedule;
				}, {});
			}.bind(this)).catch(function () {
				// A resource that isn't found, or a service hiccup, falls back to every day
				// being treated as working in _loadWeek/_loadDay rather than blocking them.
				this._oWorkSchedule = {};
			}.bind(this));
		},

		/**
		 * Reads one week of bookings. Both the ring row and the Quick Timesheet card work
		 * off this response.
		 * @param {Date} oMonday the first day of the week
		 * @returns {Promise<object>} the service response
		 */
		_fetchWeek: function (oMonday) {
			var aDates = Backend.weekDates(oMonday);

			return Backend.getJson(Backend.query(Backend.TIMESHEET, {
				cmd: "fetch",
				Email: this._sUserEmail,
				FromDate: Backend.isoDate(aDates[0]),
				ToDate: Backend.isoDate(aDates[6]),
				OrgID: this._sOrgId
			})).then(function (oData) {
				this._sUserId = (oData.user || {}).empID || this._sUserId;
				return oData;
			}.bind(this));
		},

		/**
		 * Builds the ring for each day of this week: complete, short, missing, on leave,
		 * or not due yet.
		 * @returns {Promise} resolved once the rings are in the model
		 */
		_loadWeek: function () {
			var oModel = this.getModel();
			var oMonday = Backend.mondayOf(new Date());
			var aDates = Backend.weekDates(oMonday);

			oModel.setProperty("/loadingWeek", true);
			oModel.setProperty("/week/label", formatter.dateRange(aDates[0], aDates[6]));

			return Promise.all([this._fetchWeek(oMonday), this._pWorkScheduleLoaded]).then(function (aResults) {
				var oData = aResults[0];
				var oUser = oData.user || {};
				var oSchedule = this._oWorkSchedule || {};

				this._oWeekTotals = this._weekTotals(oData);
				oModel.setProperty("/week/status", this._weekStatus(this._oWeekTotals));
				var mLeave = {};
				Backend.countedLeaves(oData.leaves).concat(oData.bankHolidays || []).forEach(function (oEntry) {
					mLeave[Backend.dayKey(oEntry.Date)] = oEntry;
				});

				var iWorkingDays = DAYS.filter(function (oDay) {
					return oSchedule[oDay.schedule] !== "N";
				}).length || 5;
				var iTargetPerDay = Math.round(Backend.toMinutes(oUser.targetHrsPerWeek) / iWorkingDays);
				var sToday = Backend.isoDate(new Date());

				oModel.setProperty("/weekRings", DAYS.map(function (oDay, iIndex) {
					var sDate = Backend.isoDate(aDates[iIndex]);
					var bWorking = oSchedule[oDay.schedule] !== "N";
					var iBooked = this._bookedMinutes(oData, sDate);

					// A day off owes no time at all, so anything booked against it is
					// already more than was asked for - but only once there is a target to
					// be over. Without one (a resource with no weekly hours on record)
					// nothing can be judged either way, so no day is called overbooked.
					var iDayTarget = bWorking ? iTargetPerDay : 0;
					var bOverbooked = iTargetPerDay > 0 && iBooked > iDayTarget;

					// The ring can never read past a full circle - the control clamps the
					// figure it prints to 100% and logs an error above that - so
					// overbooking is carried by the ring's colour and its tooltip rather
					// than by a percentage the chart would refuse to show.
					var iPercent = iDayTarget
						? Math.min(iBooked * 100 / iDayTarget, 100)
						: (bOverbooked ? 100 : 0);

					// The true figure, uncapped - 20:00 against an 8:00 day reads 250%.
					// It is rendered as our own label over the ring (see hrxRingPercent in
					// style.css) because the chart's built-in one cannot print past 100%.
					// A day with no target has no denominator, so there is no percentage
					// to state and the tooltip carries the hours instead.
					var sPercentLabel = iDayTarget
						? Math.round(iBooked * 100 / iDayTarget) + "%"
						: (iBooked ? "—" : "0%");

					if (mLeave[sDate]) {
						return {
							day: oDay.label,
							onLeave: true,
							percent: 100,
							state: "Neutral",
							label: this.getText("legendOnLeave"),
							percentLabel: "",
							tooltip: this.getText("legendOnLeave")
						};
					}

					// Checked ahead of the not-due-yet branch: time booked over target on
					// a day still to come is just as overbooked as on a day gone by.
					if (bOverbooked) {
						return {
							day: oDay.label,
							onLeave: false,
							percent: 100,
							state: RING_OVERBOOKED,
							label: Backend.fromMinutes(iBooked),
							percentLabel: sPercentLabel,
							tooltip: this.getText("ringTooltipOverbooked", [
								Backend.fromMinutes(iBooked),
								Backend.fromMinutes(iDayTarget),
								Backend.fromMinutes(iBooked - iDayTarget)
							])
						};
					}

					if (!bWorking || sDate > sToday) {
						return {
							day: oDay.label,
							onLeave: false,
							percent: iPercent,
							state: "Neutral",
							label: iBooked ? Backend.fromMinutes(iBooked) : "—",
							percentLabel: sPercentLabel,
							tooltip: bWorking
								? this.getText("ringTooltipNotDue", [
									Backend.fromMinutes(iBooked), Backend.fromMinutes(iDayTarget)
								])
								: this.getText("qtNonWorkingDay")
						};
					}

					return {
						day: oDay.label,
						onLeave: false,
						percent: iPercent,
						state: iBooked >= iDayTarget ? "Good" : iBooked > 0 ? "Critical" : "Error",
						label: Backend.fromMinutes(iBooked),
						percentLabel: sPercentLabel,
						tooltip: this.getText("ringTooltipBooked", [
							Backend.fromMinutes(iBooked), Backend.fromMinutes(iDayTarget)
						])
					};
				}, this));

				oModel.setProperty("/loadingWeek", false);
			}.bind(this)).catch(function (oError) {
				oModel.setProperty("/weekRings", []);
				oModel.setProperty("/week/status", this._weekStatus(null));
				oModel.setProperty("/loadingWeek", false);
				this._showError("homeErrorWeek", oError);
			}.bind(this));
		},

		/**
		 * Adds up what has been booked this week against what is owed, with leave and
		 * bank holidays reducing the target rather than counting as booked time.
		 * @param {object} oData the timesheet response
		 * @returns {object|null} the booked and target minutes
		 */
		_weekTotals: function (oData) {
			if (!oData || !oData.user) {
				return null;
			}

			var iBooked = this._timeEntries(oData).reduce(function (iTotal, oItem) {
				return iTotal + Backend.toMinutes(oItem.entry.Hours);
			}, 0);

			var iTarget = Backend.toMinutes(oData.user.targetHrsPerWeek);
			iTarget -= Backend.countedLeaves(oData.leaves).reduce(function (iTotal, oEntry) {
				return iTotal + Backend.toMinutes(oEntry.Hours);
			}, 0);
			iTarget -= (oData.bankHolidays || []).filter(function (oEntry) {
				return oEntry.Day !== "Saturday" && oEntry.Day !== "Sunday";
			}).reduce(function (iTotal, oEntry) {
				return iTotal + Backend.toMinutes(oEntry.Hours);
			}, 0);

			return { booked: iBooked, target: Math.max(iTarget, 0) };
		},

		/**
		 * Builds the health-strip pills shown at the top of the shell from data this
		 * page has already fetched for itself - the week just loaded, the leave-user
		 * balance and the approvals list - rather than App.controller fetching the same
		 * week/leave/approvals a second time.
		 */
		_updateHealthStrip: function () {
			var oAppController = this.getOwnerComponent().getRootControl().getController();
			if (!oAppController || typeof oAppController.setHealthStrip !== "function") {
				return;
			}

			var oModel = this.getModel();
			var aStrip = [];

			// The hours still to book used to lead this strip. They are the week's own
			// figure, so they are shown on the Timesheet card with the week they
			// describe - see _weekStatus - rather than beside the page title, where
			// nothing said which week or which timesheet they referred to.

			// One pill per person waiting, not per day, so it lines up with the
			// approvals card on the home page.
			var iPending = (oModel.getProperty("/approvals") || []).length;
			if (iPending) {
				aStrip.push({
					text: this.getText("stripApprovalsPending", [iPending]),
					state: "Warning"
				});
			}

			var oUser = oModel.getProperty("/user") || {};
			if (oUser.email) {
				var fBalance = parseFloat(oUser.balanceLeaves) || 0;
				aStrip.push({
					text: this.getText("stripLeaveBalance", [fBalance]),
					state: fBalance > 0 ? "Success" : "Error"
				});
			}

			oAppController.setHealthStrip(aStrip);
		},

		/**
		 * @param {object|null} oTotals the week's booked and target minutes
		 * @returns {object} the pill on the Timesheet card: what is still to book, or
		 * that the week is on track - empty when there is no week to judge
		 */
		_weekStatus: function (oTotals) {
			if (!oTotals) {
				return { text: "", state: "None" };
			}
			if (oTotals.booked >= oTotals.target) {
				return { text: this.getText("stripTimesheetOnTrack"), state: "Success" };
			}
			return {
				text: this.getText("stripTimesheetShort", [Backend.fromMinutes(oTotals.target - oTotals.booked)]),
				state: "Warning"
			};
		},

		/**
		 * @param {object} oData a timesheet response
		 * @param {string} sDate the day as yyyy-MM-dd
		 * @returns {number} the minutes booked on that day
		 */
		_bookedMinutes: function (oData, sDate) {
			return this._timeEntries(oData).filter(function (oItem) {
				return Backend.dayKey(oItem.entry.Date) === sDate;
			}).reduce(function (iTotal, oItem) {
				return iTotal + Backend.toMinutes(oItem.entry.Hours);
			}, 0);
		},

		/**
		 * The week's time entries, one per project per day - as My Timesheet shows them.
		 * A project can come back on more than one assignment row, and each of those rows
		 * carries the project's entries, so adding up every row's entries counted that
		 * project's time once per row. Keyed the way the grid's _buildRows is, where a
		 * later row's entry for the same day replaces an earlier one.
		 * @param {object} oData a timesheet response
		 * @returns {Array<{assignment: object, entry: object}>} each entry with the row it came on
		 */
		_timeEntries: function (oData) {
			var mEntries = {};
			(oData.assignments || []).forEach(function (oAssignment) {
				(oAssignment.TimeEntries || []).forEach(function (oEntry) {
					mEntries[oAssignment.ProjectID + "|" + Backend.dayKey(oEntry.Date)] = {
						assignment: oAssignment,
						entry: oEntry
					};
				});
			});
			return Object.keys(mEntries).map(function (sKey) {
				return mEntries[sKey];
			});
		},

		/**
		 * Loads the day chosen in the Quick Timesheet card: which projects can be booked
		 * against, and what has already been logged.
		 * @returns {Promise} resolved once the card is filled
		 */
		_loadDay: function () {
			var oModel = this.getModel();
			var sDay = oModel.getProperty("/quick/day");
			var oDay = formatter.toDate(sDay);
			if (!oDay) {
				return Promise.resolve();
			}

			oModel.setProperty("/loadingDay", true);
			oModel.setProperty("/quick/dayLabel", this._dayLabel(oDay));
			oModel.setProperty("/quick/dayFullLabel", oDay.toLocaleDateString("en-GB", {
				weekday: "long", day: "numeric", month: "long", year: "numeric"
			}));

			return Promise.all([this._fetchWeek(Backend.mondayOf(oDay)), this._pWorkScheduleLoaded]).then(function (aResults) {
				var oData = aResults[0];
				var aAssignments = oData.assignments || [];
				var mSeen = {};
				var aProjects = [];
				var aEntries = [];
				var iBooked = 0;

				var oLeaveEntry = Backend.countedLeaves(oData.leaves).concat(oData.bankHolidays || []).filter(function (oEntry) {
					return Backend.dayKey(oEntry.Date) === sDay;
				})[0];
				var oSchedule = this._oWorkSchedule || {};
				var sScheduleKey = oDay.toLocaleDateString("en-US", { weekday: "long" });
				var bWorking = oSchedule[sScheduleKey] !== "N";

				oModel.setProperty("/quick/dayEditable", bWorking && !oLeaveEntry);
				oModel.setProperty("/quick/dayEditableReason",
					oLeaveEntry ? this.getText("legendOnLeave") : (!bWorking ? this.getText("qtNonWorkingDay") : ""));

				aAssignments.forEach(function (oAssignment) {
					if (!mSeen[oAssignment.ProjectID]) {
						mSeen[oAssignment.ProjectID] = true;
						aProjects.push({
							ProjectID: oAssignment.ProjectID,
							ClientKey: oAssignment.ClientKey,
							label: (oAssignment.ClientDesc || "") + " — " + oAssignment.ProjectDesc
						});
					}
				});

				this._timeEntries(oData).forEach(function (oItem) {
					var oEntry = oItem.entry;
					if (Backend.dayKey(oEntry.Date) !== sDay) {
						return;
					}
					var sHours = this._trimSeconds(oEntry.Hours);
					if (!sHours || sHours === "00:00") {
						return;
					}
					iBooked += Backend.toMinutes(sHours);
					aEntries.push({
						ProjectID: oItem.assignment.ProjectID,
						project: oItem.assignment.ProjectDesc,
						time: sHours,
						comment: formatter.clean(oEntry.Comment),
						recId: oEntry.RecID || ""
					});
				}, this);

				aProjects.sort(function (a, b) {
					return a.label.localeCompare(b.label);
				});

				oModel.setProperty("/quick/projects", aProjects);
				oModel.setProperty("/quick/entries", aEntries);
				oModel.setProperty("/quick/bookedTotal", Backend.fromMinutes(iBooked));
				oModel.setProperty("/quick/logged", aEntries.length > 0);
				oModel.setProperty("/loadingDay", false);
			}.bind(this)).catch(function (oError) {
				oModel.setProperty("/quick/projects", []);
				oModel.setProperty("/quick/entries", []);
				oModel.setProperty("/quick/logged", false);
				oModel.setProperty("/quick/dayEditable", false);
				oModel.setProperty("/quick/dayEditableReason", "");
				oModel.setProperty("/loadingDay", false);
				this._showError("homeErrorDay", oError);
			}.bind(this));
		},

		/**
		 * Loads the leave waiting for the signed-in manager's decision, one row per
		 * requester.
		 * @returns {Promise} resolved once the approvals are in the model
		 */
		_loadApprovals: function () {
			var oModel = this.getModel();
			oModel.setProperty("/loadingApprovals", true);
			return Backend.getJson(Backend.query(Backend.LEAVE_APPROVALS, {
				cmd: "pendingApproval",
				Email: this._sUserEmail,
				OrgID: this._sOrgId
			})).then(function (oData) {
				var mByRequester = {};

				(oData.leaveToApprove || []).forEach(function (oLeave) {
					var oGroup = mByRequester[oLeave.RequesterID];
					if (!oGroup) {
						oGroup = mByRequester[oLeave.RequesterID] = {
							RequesterID: oLeave.RequesterID,
							RequesterName: oLeave.RequesterName,
							RequesterEmail: oLeave.RequesterEmail,
							LeaveType: oLeave.LeaveType,
							initials: formatter.nameInitials(oLeave.RequesterName),
							LeaveList: []
						};
					}
					oGroup.LeaveList.push(oLeave);
				});

				oModel.setProperty("/approvals", Object.keys(mByRequester).map(function (sKey) {
					var oGroup = mByRequester[sKey];
					var aDates = oGroup.LeaveList.map(function (oLeave) {
						return oLeave.Date;
					}).sort();

					oGroup.title = oGroup.RequesterName + " — " + oGroup.LeaveType;
					oGroup.meta = formatter.dateRange(aDates[0], aDates[aDates.length - 1]) +
						" · " + this.getText("homeDaysCount", [oGroup.LeaveList.length]);
					return oGroup;
				}, this));

				oModel.setProperty("/loadingApprovals", false);
			}.bind(this)).catch(function (oError) {
				oModel.setProperty("/approvals", []);
				oModel.setProperty("/loadingApprovals", false);
				this._showError("homeErrorApprovals", oError);
			}.bind(this));
		},

		/* =========================================================== */
		/* quick timesheet                                             */
		/* =========================================================== */

		onQuickDayChange: function (oEvent) {
			var oPicker = oEvent.getSource();
			if (!oEvent.getParameter("valid")) {
				oPicker.setValueState("Error");
				oPicker.setValueStateText(this.getText("homeInvalidDay"));
				return;
			}

			oPicker.setValueState("None");
			this.getModel().setProperty("/quick/hours", "");
			this.getModel().setProperty("/quick/comment", "");
			this._loadDay();
		},

		/**
		 * Normalises whatever was typed into hh:mm as soon as the field is left, the same
		 * way the Timesheet grid does.
		 * @param {sap.ui.base.Event} oEvent the input change event
		 */
		onQuickHoursChange: function (oEvent) {
			var oInput = oEvent.getSource();
			var sValue = (oInput.getValue() || "").trim();
			var sNormalised = this._normaliseTime(sValue);

			if (sValue && sNormalised === null) {
				oInput.setValueState("Error");
				oInput.setValueStateText(this.getText("tsInvalidTime"));
				return;
			}

			oInput.setValueState("None");
			this.getModel().setProperty("/quick/hours", sNormalised || "");
		},

		/**
		 * Returns to the entry form so more time can be booked against the same day.
		 */
		onLogMoreTime: function () {
			this.getModel().setProperty("/quick/logged", false);
		},

		/**
		 * Books the time against the chosen day. Re-booking a project that already has an
		 * entry that day updates it rather than adding a second one.
		 */
		onSaveQuickTimesheet: function () {
			var oModel = this.getModel();
			var oQuick = oModel.getProperty("/quick");
			var sHours = this._normaliseTime((oQuick.hours || "").trim());

			if (!oQuick.day) {
				MessageToast.show(this.getText("homeNeedDay"));
				return;
			}
			if (!oQuick.dayEditable) {
				MessageToast.show(oQuick.dayEditableReason || this.getText("qtNonWorkingDay"));
				return;
			}
			if (!oQuick.ProjectID) {
				MessageToast.show(this.getText("homeNeedProject"));
				return;
			}
			if (!sHours || sHours === "00:00") {
				this.byId("qtHours").setValueState("Error");
				this.byId("qtHours").setValueStateText(this.getText("tsInvalidTime"));
				MessageToast.show(this.getText("homeNeedHours"));
				return;
			}
			if (!(oQuick.comment || "").trim()) {
				MessageToast.show(this.getText("homeNeedComment"));
				return;
			}

			this.byId("qtHours").setValueState("None");

			var oExisting = (oQuick.entries || []).filter(function (oEntry) {
				return oEntry.ProjectID === oQuick.ProjectID;
			})[0];
			var oNow = new Date();

			oModel.setProperty("/loadingDay", true);

			Backend.postJson(Backend.TIMESHEET + "?cmd=save", {
				OrgID: this._sOrgId,
				UserID: this._sUserId,
				SavedOn: Backend.isoDate(oNow),
				SavedAt: Backend.clockTime(oNow),
				SavedBy: this._sUserId,
				TimesheetListSet: [{
					RecID: (oExisting && oExisting.recId) || "",
					ProjectKey: oQuick.ProjectID,
					Date: oQuick.day,
					Hours: sHours + ":00",
					Comment: oQuick.comment.trim()
				}]
			}).then(function (oResult) {
				MessageToast.show(oResult.msg || this.getText("tsSaved"));
				oModel.setProperty("/quick/hours", "");
				oModel.setProperty("/quick/comment", "");
				return Promise.all([this._loadDay(), this._loadWeek()]);
			}.bind(this)).catch(function (oError) {
				oModel.setProperty("/loadingDay", false);
				this._showError("tsErrorSave", oError);
			}.bind(this));
		},

		/* =========================================================== */
		/* quick leave                                                 */
		/* =========================================================== */

		/**
		 * Asks the service which of the chosen days can actually be booked - weekends,
		 * bank holidays and days already taken are left out.
		 * @param {sap.ui.base.Event} oEvent the date range change event
		 */
		onQuickLeaveDatesChange: function (oEvent) {
			var oModel = this.getModel();
			var bValid = oEvent.getParameter("valid") && !!oEvent.getParameter("value");

			oEvent.getSource().setValueState(bValid ? "None" : "Error");
			oEvent.getSource().setValueStateText(this.getText("mlMandatory"));

			if (!bValid) {
				oModel.setProperty("/quickLeave/dates", []);
				oModel.setProperty("/quickLeave/NoOfDays", 0);
				return;
			}

			var oUser = oModel.getProperty("/user") || {};

			Backend.getJson(Backend.query(Backend.LEAVE, {
				cmd: "getDates",
				FromDate: Backend.isoDate(oEvent.getParameter("from")),
				ToDate: Backend.isoDate(oEvent.getParameter("to")),
				OrgID: this._sOrgId,
				SiteID: oUser.siteID || "",
				EmpID: oUser.empID || ""
			})).then(function (oData) {
				oModel.setProperty("/quickLeave/dates", oData.dates || []);
				this._updateLeaveDayCount();
			}.bind(this)).catch(function (oError) {
				oModel.setProperty("/quickLeave/dates", []);
				oModel.setProperty("/quickLeave/NoOfDays", 0);
				this._showError("mlErrorDates", oError);
			}.bind(this));
		},

		onQuickLeaveDurationChange: function () {
			this._updateLeaveDayCount();
		},

		/**
		 * Half days count as half a day towards the request.
		 */
		_updateLeaveDayCount: function () {
			var oModel = this.getModel();
			var aDates = oModel.getProperty("/quickLeave/dates") || [];
			var bHalf = oModel.getProperty("/quickLeave/DayTime") !== "Full Day";

			oModel.setProperty("/quickLeave/NoOfDays", aDates.reduce(function (fTotal, oDay) {
				// A day with only one free half can never be taken as a whole one.
				return fTotal + (bHalf || oDay.availableSlot ? 0.5 : 1);
			}, 0));
		},

		/**
		 * Submits the request to the user's manager for approval.
		 */
		onRequestLeave: function () {
			var oModel = this.getModel();
			var oForm = oModel.getProperty("/quickLeave");
			var oUser = oModel.getProperty("/user") || {};
			var aDates = oForm.dates || [];

			if (!aDates.length) {
				MessageToast.show(this.getText("mlNoBookableDays"));
				return;
			}
			if (parseFloat(oForm.NoOfDays) > parseFloat(oUser.balanceLeaves || 0) && oForm.LeaveCategoryId === "HOLIL") {
				MessageBox.warning(this.getText("mlWarnOverBalance", [oForm.NoOfDays, oUser.balanceLeaves]));
			}

			var sToday = Backend.isoDate(new Date());

			var aRequests = aDates.map(function (oDay) {
				// A day with one half already taken can only take the other half.
				var sDayTime = oDay.availableSlot || oForm.DayTime;

				return {
					OrgID: this._sOrgId,
					LeaveID: "",
					EmpID: oUser.empID,
					EmpName: oUser.name,
					EmpEmail: this._sUserEmail,
					EmpSite: oUser.siteID || "",
					IsPaid: oForm.LeaveCategoryId === "UNPDL" ? "N" : "Y",
					LeaveCategoryId: oForm.LeaveCategoryId,
					NoOfDays: "1",
					StartDate: oDay.date,
					EndDate: oDay.date,
					DayTime: sDayTime,
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

			oModel.setProperty("/savingLeave", true);

			Backend.postJson(Backend.LEAVE + "?cmd=requestLeave", { LeaveReqSet: aRequests })
				.then(function (oResult) {
					MessageToast.show(oResult.msg || this.getText("mlRequested"));
					oModel.setProperty("/savingLeave", false);
					oModel.setProperty("/quickLeave", this._emptyQuickLeave());
					this.byId("qlDateRange").setValue("");
					return this._loadLeaveUser();
				}.bind(this)).catch(function (oError) {
					oModel.setProperty("/savingLeave", false);
					this._showError("mlErrorRequest", oError);
				}.bind(this));
		},

		/* =========================================================== */
		/* approvals                                                   */
		/* =========================================================== */

		onApproveLeave: function (oEvent) {
			this._actionLeave(oEvent, "APR");
		},

		onRejectLeave: function (oEvent) {
			this._actionLeave(oEvent, "REJ");
		},

		/**
		 * Decides every pending day of one requester in a single call.
		 * @param {sap.ui.base.Event} oEvent the button press event
		 * @param {string} sStatus "APR" or "REJ"
		 */
		_actionLeave: function (oEvent, sStatus) {
			var oContext = oEvent.getSource().getBindingContext("home");
			if (!oContext) {
				return;
			}

			var oGroup = oContext.getObject();
			var sToday = Backend.isoDate(new Date());
			var oModel = this.getModel();

			var aLeaveRequests = oGroup.LeaveList.map(function (oLeave) {
				return {
					LeaveID: oLeave.LeaveID,
					RequesterID: oGroup.RequesterID,
					RequesterName: oGroup.RequesterName,
					RequesterEmail: oGroup.RequesterEmail,
					Status: sStatus,
					OrgID: this._sOrgId,
					ApprovedOn: sToday,
					ApprovedBy: this._oProfile.empID,
					ApproverName: this._oProfile.name,
					ApproverEmail: this._sUserEmail
				};
			}, this);

			oModel.setProperty("/loadingApprovals", true);

			Backend.postJson(Backend.LEAVE_APPROVALS + "?cmd=action", { LeaveReqSet: aLeaveRequests })
				.then(function (oResult) {
					MessageToast.show(oResult.msg ||
						this.getText(sStatus === "APR" ? "tcLeaveApproved" : "tcLeaveRejected"));
					return this._loadApprovals();
				}.bind(this)).catch(function (oError) {
					oModel.setProperty("/loadingApprovals", false);
					this._showError("tcErrorApprovalAction", oError);
				}.bind(this));
		},

		/* =========================================================== */
		/* formatters                                                  */
		/* =========================================================== */

		formatPendingCount: function (aApprovals) {
			return this.getText("approvalsPending", [(aApprovals || []).length]);
		},

		formatLoggedTitle: function (sTotal) {
			return this.getText("qtLogged", [sTotal || "0:00"]);
		},

		/* =========================================================== */
		/* helpers                                                     */
		/* =========================================================== */

		getModel: function () {
			return this.getView().getModel("home");
		},

		getResourceBundle: function () {
			return this.getOwnerComponent().getModel("i18n").getResourceBundle();
		},

		getText: function (sKey, aArgs) {
			return this.getResourceBundle().getText(sKey, aArgs);
		},

		_dayLabel: function (oDate) {
			var sToday = Backend.isoDate(new Date());
			if (Backend.isoDate(oDate) === sToday) {
				return this.getText("today");
			}
			return oDate.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
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
		 * Durations arrive either as hh:mm:ss or already as hh:mm, so only a third part
		 * may be dropped.
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

		_emptyQuickEntry: function () {
			return Object.assign({
				day: Backend.isoDate(new Date()),
				dayLabel: "",
				dayFullLabel: "",
				projects: [],
				entries: [],
				bookedTotal: "0:00",
				logged: false,
				dayEditable: true,
				dayEditableReason: ""
			}, { ProjectID: "", hours: "", comment: "" });
		},

		_emptyQuickLeave: function () {
			return {
				LeaveCategoryId: "HOLIL",
				DayTime: "Full Day",
				Comments: "",
				NoOfDays: 0,
				dates: []
			};
		},

		_emptyState: function () {
			return {
				loadingWeek: false,
				loadingDay: false,
				loadingApprovals: false,
				savingLeave: false,
				user: {},
				leaveTypes: [],
				projectTypes: [],
				approvals: [],
				quickLeave: this._emptyQuickLeave(),
				quick: this._emptyQuickEntry(),
				week: { label: "", status: { text: "", state: "None" } },
				weekRings: []
			};
		},

		_errorText: function (oError) {
			if (!oError) {
				return "";
			}
			return oError.message || String(oError);
		},

		_showError: function (sTextKey, oError) {
			MessageBox.error(this.getText(sTextKey), {
				details: this._errorText(oError)
			});
		}
	});
});
