sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"../model/Backend",
	"../model/formatter"
], function (Controller, JSONModel, MessageBox, Backend, formatter) {
	"use strict";

	// Root path of the backend services - see xs-app.json (deployed) and ui5.yaml (local).
	var TIMESHEET_SERVICE = Backend.TIMESHEET;

	return Controller.extend("bsx.hrx.hrx2026.controller.MissingTimesheets", {

		formatter: formatter,

		/* =========================================================== */
		/* lifecycle                                                   */
		/* =========================================================== */

		onInit: function () {
			this.setModel(new JSONModel({
				busy: true,
				month: new Date(),
				monthLabel: "",
				periodLabel: "",
				userType: "S",
				title: this.getText("mtListTitle"),
				kpis: this._emptyKpis()
			}), "mtView");

			this.setModel(new JSONModel({ all: [], rows: [] }), "mt");

			this.getOwnerComponent().getRouter().getRoute("missingtimesheets")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		/**
		 * The view is reused across navigations, so every entry reloads the report for
		 * the current month rather than showing a stale one.
		 */
		_onRouteMatched: function () {
			this.getModel("mtView").setProperty("/month", new Date());
			this._loadReport();
		},

		/* =========================================================== */
		/* data loading                                                */
		/* =========================================================== */

		/**
		 * Loads the report for the selected month. The period ends today when the
		 * selected month is the current one, so people are not marked as missing time
		 * for days that have not happened yet.
		 * @returns {Promise} resolved once the report is in the model
		 */
		_loadReport: function () {
			var oViewModel = this.getModel("mtView");
			var oMonth = formatter.toDate(oViewModel.getProperty("/month")) || new Date();
			var oToday = new Date();

			var oFirstDay = new Date(oMonth.getFullYear(), oMonth.getMonth(), 1);
			var bCurrentMonth = oMonth.getFullYear() === oToday.getFullYear() && oMonth.getMonth() === oToday.getMonth();
			var oLastDay = bCurrentMonth ? oToday : new Date(oMonth.getFullYear(), oMonth.getMonth() + 1, 0);

			oViewModel.setProperty("/busy", true);
			oViewModel.setProperty("/monthLabel", this._monthLabel(oMonth));
			oViewModel.setProperty("/periodLabel", this.getText("mtPeriod", [
				formatter.date(oFirstDay), formatter.date(oLastDay)
			]));

			return this._getJson(TIMESHEET_SERVICE + "?cmd=missingTimesheet&" + new URLSearchParams({
				fromDate: this._isoDate(oFirstDay),
				toDate: this._isoDate(oLastDay)
			}).toString()).then(function (aData) {
				this.getModel("mt").setProperty("/all", (aData || []).map(this._toRow, this));
				this._applyFilter();
				oViewModel.setProperty("/busy", false);
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/busy", false);
				this.getModel("mt").setProperty("/all", []);
				this._applyFilter();
				this._showError("mtErrorReport", oError);
			}.bind(this));
		},

		/**
		 * Turns a service row into the shape the table binds against, deriving the
		 * completion percentage and its traffic-light state.
		 * @param {object} oUser one row of the report
		 * @returns {object} the display row
		 */
		_toRow: function (oUser) {
			var iExpected = parseInt(oUser.ExpectedBookingInSecond, 10) || 0;
			var iBooked = parseInt(oUser.ActualBookedInSecond, 10) || 0;
			var iMissing = parseInt(oUser.MissingTimeInSecond, 10) || 0;

			var iCompletion = (iBooked > 0 && iExpected > 0) ? Math.round(iBooked * 100 / iExpected) : 0;
			var sCompletionText;
			if (iBooked <= 0) {
				sCompletionText = this.getText("mtNotBooked");
			} else if (iCompletion >= 100) {
				sCompletionText = this.getText("mtComplete");
			} else {
				sCompletionText = iCompletion + "%";
			}

			return {
				OrgID: oUser.OrgID,
				UserID: oUser.UserID,
				FullName: ((oUser.FName || "") + " " + (oUser.LName || "")).trim(),
				FName: oUser.FName || "",
				LName: oUser.LName || "",
				Email: oUser.Email || "",
				Pic: oUser.Pic || "",
				UserTypeKey: oUser.UserTypeKey || "",
				BaseSiteKey: oUser.BaseSiteKey || "",
				ExpectedHours: this._toHoursAndMinutes(oUser.ExpectedBookingInHour),
				BookedHours: this._toHoursAndMinutes(oUser.ActualBookedInHour),
				LeaveHours: this._toHoursAndMinutes(oUser.LeaveTakenInHours),
				MissingHours: iMissing > 0 ? this._toHoursAndMinutes(oUser.MissingTimeInHour) : "",
				MissingSeconds: iMissing,
				Completion: Math.min(iCompletion, 100),
				CompletionText: sCompletionText,
				CompletionState: iCompletion < 75 ? "Error" : iCompletion < 90 ? "Warning" : "Success"
			};
		},

		/**
		 * Applies the resource type filter, sorts the worst offenders to the top and
		 * recalculates the header numbers.
		 */
		_applyFilter: function () {
			var oViewModel = this.getModel("mtView");
			var sUserType = oViewModel.getProperty("/userType");

			var aRows = (this.getModel("mt").getProperty("/all") || []).filter(function (oRow) {
				return sUserType === "ALL" || oRow.UserTypeKey === sUserType;
			}).sort(function (a, b) {
				return (b.MissingSeconds - a.MissingSeconds) || a.FullName.localeCompare(b.FullName);
			});

			var aDefaulters = aRows.filter(function (oRow) {
				return oRow.MissingSeconds > 0;
			});
			var iMissingSeconds = aDefaulters.reduce(function (iTotal, oRow) {
				return iTotal + oRow.MissingSeconds;
			}, 0);

			this.getModel("mt").setProperty("/rows", aRows);
			oViewModel.setProperty("/kpis", {
				resources: aRows.length,
				defaulters: aDefaulters.length,
				missingHours: this._secondsToHours(iMissingSeconds),
				defaulterState: aDefaulters.length ? "Error" : "Good"
			});
			oViewModel.setProperty("/title", this.getText("mtListTitleCount", [aRows.length]));
		},

		/* =========================================================== */
		/* events                                                      */
		/* =========================================================== */

		onMonthChange: function () {
			this._loadReport();
		},

		onUserTypeChange: function () {
			this._applyFilter();
		},

		onRefresh: function () {
			this._loadReport();
		},

		/**
		 * Steps the report one month back or forward.
		 * @param {sap.ui.base.Event} oEvent the button press event
		 */
		onStepMonth: function (oEvent) {
			var iStep = oEvent.getSource().data("step") === "next" ? 1 : -1;
			var oViewModel = this.getModel("mtView");
			var oMonth = formatter.toDate(oViewModel.getProperty("/month")) || new Date();

			oViewModel.setProperty("/month", new Date(oMonth.getFullYear(), oMonth.getMonth() + iStep, 1));
			this._loadReport();
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

		_getJson: function (sUrl) {
			return fetch(sUrl, { method: "GET" }).then(function (oResponse) {
				return oResponse.text().then(function (sBody) {
					var vJson = null;
					try {
						vJson = sBody ? JSON.parse(sBody) : null;
					} catch (oParseError) {
						vJson = null;
					}

					// This report answers with a bare array rather than the usual envelope.
					if (!oResponse.ok || !vJson) {
						throw new Error((vJson && (vJson.msg || vJson.message)) || sBody || oResponse.statusText);
					}

					return vJson;
				});
			});
		},

		/**
		 * The service reports durations as "HH:mm:ss"; the seconds add nothing here.
		 * @param {string} sDuration a duration
		 * @returns {string} the duration without seconds
		 */
		_toHoursAndMinutes: function (sDuration) {
			if (!sDuration || sDuration === "None") {
				return "";
			}
			return String(sDuration).replace(/:\d{2}$/, "");
		},

		/**
		 * The KPI tile has little room, so the total is rounded to whole hours - the
		 * table still shows each person's missing time to the minute.
		 * @param {number} iSeconds total missing seconds
		 * @returns {string} whole hours
		 */
		_secondsToHours: function (iSeconds) {
			return String(Math.round(iSeconds / 3600));
		},

		_monthLabel: function (oDate) {
			return oDate.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
		},

		_isoDate: function (oDate) {
			var sMonth = String(oDate.getMonth() + 1).padStart(2, "0");
			var sDay = String(oDate.getDate()).padStart(2, "0");
			return oDate.getFullYear() + "-" + sMonth + "-" + sDay;
		},

		_emptyKpis: function () {
			return { resources: 0, defaulters: 0, missingHours: "0:00", defaulterState: "Good" };
		},

		_showError: function (sTextKey, oError) {
			MessageBox.error(this.getText(sTextKey), {
				details: (oError && oError.message) || String(oError)
			});
		}
	});
});
