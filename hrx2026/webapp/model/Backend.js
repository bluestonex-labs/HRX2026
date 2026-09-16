sap.ui.define([], function () {
	"use strict";

	// Root of the backend services - see xs-app.json (deployed) and ui5.yaml (local).
	//
	// The app sits at the root of the host while it is served by the development
	// server, but under a path of its own once it is deployed to the HTML5 repository
	// and opened from a launchpad site. A leading slash would leave the deployed app
	// asking the site root for /services, which nothing there answers, so the root is
	// resolved from the app's own url instead.
	var SERVICE_ROOT = new URL(
		sap.ui.require.toUrl("bsx/hrx/hrx2026") + "/services",
		document.baseURI
	).href;

	/**
	 * Every xsjs service answers HTTP 200 with a msgType of "S" on success and carries
	 * the reason in msg otherwise, so a failed call has to be recognised from the body
	 * rather than from the status code.
	 * @param {string} sUrl the service url
	 * @param {object} [oInit] fetch options
	 * @returns {Promise<object>} the parsed response
	 */
	function request(sUrl, oInit) {
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
	}

	// Several cards can want the same week or the same profile at the same moment.
	// Identical GETs that are still in flight share one request; once a request has
	// settled it is dropped, so nothing is ever answered from a stale copy.
	var mInFlight = {};

	function getJson(sUrl) {
		if (mInFlight[sUrl]) {
			return mInFlight[sUrl];
		}

		var pRequest = request(sUrl, { method: "GET" });
		mInFlight[sUrl] = pRequest;

		var fnForget = function () {
			delete mInFlight[sUrl];
		};
		pRequest.then(fnForget, fnForget);

		return pRequest;
	}

	return {

		SERVICE_ROOT: SERVICE_ROOT,

		TIMESHEET: SERVICE_ROOT + "/timesheet/timesheet.xsjs",
		LEAVE: SERVICE_ROOT + "/hrx/leaveReqs.xsjs",
		LEAVE_APPROVALS: SERVICE_ROOT + "/hrx/leaveApprovals.xsjs",
		TEAM: SERVICE_ROOT + "/hrx/teamCalendar1.xsjs",

		request: request,

		/**
		 * @param {string} sUrl the service url, query string included
		 * @returns {Promise<object>} the parsed response
		 */
		getJson: getJson,

		/**
		 * @param {string} sUrl the service url, query string included
		 * @param {object} oPayload the request body
		 * @returns {Promise<object>} the parsed response
		 */
		postJson: function (sUrl, oPayload) {
			return request(sUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(oPayload)
			});
		},

		/**
		 * @param {string} sUrl a service url
		 * @param {object} oParams the query parameters
		 * @returns {string} the url with its query string
		 */
		query: function (sUrl, oParams) {
			return sUrl + "?" + new URLSearchParams(oParams).toString();
		},

		/**
		 * @param {Date} oDate a day
		 * @returns {string} the day as yyyy-MM-dd
		 */
		isoDate: function (oDate) {
			if (!oDate) {
				return "";
			}
			var sMonth = String(oDate.getMonth() + 1).padStart(2, "0");
			var sDay = String(oDate.getDate()).padStart(2, "0");
			return oDate.getFullYear() + "-" + sMonth + "-" + sDay;
		},

		/**
		 * Reduces any date the services hand back to the day it falls on, so two of
		 * them can be compared whatever shape each arrived in. The xsjs services answer
		 * "yyyy-MM-dd", OData answers "/Date(<ms>)/" and the model hands back real Date
		 * objects - slicing the first ten characters off the raw value only works for
		 * the first of the three, which is what left booked time invisible on the home
		 * page's week snapshot while the timesheet grid showed it.
		 * @param {Date|string} vDate any date shape the services return
		 * @returns {string} the day as yyyy-MM-dd, or "" when it cannot be read
		 */
		dayKey: function (vDate) {
			if (!vDate || vDate === "None") {
				return "";
			}

			// Already a plain calendar day: take it as written rather than through a
			// Date, which would read it as UTC midnight and shift it a day west of
			// Greenwich.
			if (typeof vDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(vDate)) {
				return vDate.slice(0, 10);
			}

			var oDate = vDate instanceof Date ? vDate : null;
			if (!oDate) {
				var aTicks = /^\/Date\((-?\d+)\)\/$/.exec(String(vDate));
				oDate = new Date(aTicks ? parseInt(aTicks[1], 10) : vDate);
			}
			if (isNaN(oDate.getTime())) {
				return "";
			}

			return this.isoDate(oDate);
		},

		/**
		 * @param {Date} oDate a moment
		 * @returns {string} the time as hh:mm:ss, zero padded
		 */
		clockTime: function (oDate) {
			return [oDate.getHours(), oDate.getMinutes(), oDate.getSeconds()].map(function (iPart) {
				return String(iPart).padStart(2, "0");
			}).join(":");
		},

		/**
		 * @param {string} sTime a duration as hh:mm or hh:mm:ss
		 * @returns {number} the duration in minutes
		 */
		toMinutes: function (sTime) {
			if (!sTime || sTime === "None") {
				return 0;
			}
			var aParts = String(sTime).split(":");
			return (parseInt(aParts[0], 10) || 0) * 60 + (parseInt(aParts[1], 10) || 0);
		},

		/**
		 * @param {number} iMinutes a duration in minutes
		 * @returns {string} the duration as h:mm
		 */
		fromMinutes: function (iMinutes) {
			return Math.floor(iMinutes / 60) + ":" + String(iMinutes % 60).padStart(2, "0");
		},

		/**
		 * @param {Date} oDate any day
		 * @returns {Date} the Monday of that day's week
		 */
		mondayOf: function (oDate) {
			var oCopy = new Date(oDate.getFullYear(), oDate.getMonth(), oDate.getDate());
			oCopy.setDate(oCopy.getDate() - ((oCopy.getDay() + 6) % 7));
			return oCopy;
		},

		/**
		 * Anything short of rejected is time off. The timesheet service returns leave
		 * requests that touch the week along with the outcome of each in StatusID
		 * ("APR", "REJ", and "REQ" for one still waiting on a manager) - only a
		 * rejected request leaves the day an ordinary working day: everything else
		 * (approved, or still pending approval) must be marked as leave, must stop
		 * time being booked against it, and must reduce the week's target.
		 *
		 * An entry carrying no StatusID at all is kept - there is nothing to judge it
		 * by, so it keeps the behaviour it has always had rather than disappearing.
		 * @param {Array<object>} aLeaves the leave entries from the service
		 * @returns {Array<object>} the entries that really are time off
		 */
		countedLeaves: function (aLeaves) {
			return (aLeaves || []).filter(function (oEntry) {
				return oEntry.StatusID !== "REJ";
			});
		},

		/**
		 * @param {Date} oMonday the first day of the week
		 * @returns {Array<Date>} the seven days of that week
		 */
		weekDates: function (oMonday) {
			return [0, 1, 2, 3, 4, 5, 6].map(function (iIndex) {
				return new Date(oMonday.getFullYear(), oMonday.getMonth(), oMonday.getDate() + iIndex);
			});
		}
	};
});
