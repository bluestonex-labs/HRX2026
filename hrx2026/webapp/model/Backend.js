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

	// How long a read waits for the metadata retries in Component.js (1s + 2s + 4s of
	// backoff, plus the requests themselves) before giving up.
	var METADATA_WAIT = 15000;

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
		 * Reads an entity set, waiting for the model's metadata first.
		 *
		 * An ODataModel read issued before $metadata has landed - or after that one
		 * request failed - comes back as an error, and the value help it was filling
		 * stays empty for the rest of the session with nothing on screen to say why.
		 * Component.js retries a failed metadata load; this waits for the result of
		 * that retry rather than failing ahead of it.
		 * @param {sap.ui.model.odata.v2.ODataModel} oModel the OData model
		 * @param {string} sPath the entity set path
		 * @param {object} [mParameters] read parameters (filters, urlParameters, ...)
		 * @returns {Promise<object>} the response
		 */
		read: function (oModel, sPath, mParameters, bOptional) {
			var fnRead = function () {
				if (bOptional && !this.hasEntitySet(oModel, sPath)) {
					return Promise.resolve({ results: [] });
				}
				return new Promise(function (resolve, reject) {
					oModel.read(sPath, Object.assign({}, mParameters, {
						success: resolve,
						error: reject
					}));
				});
			}.bind(this);

			return oModel.metadataLoaded().then(fnRead, function () {
				// The first metadata attempt failed. Component.js is already retrying
				// with a backoff, so wait for one of those to land rather than failing
				// ahead of them. The window covers that whole backoff; past it there is
				// nothing left to wait for.
				return new Promise(function (resolve, reject) {
					var bSettled = false;

					var iTimer = setTimeout(function () {
						bSettled = true;
						reject(new Error("Service metadata could not be loaded"));
					}, METADATA_WAIT);

					oModel.attachEventOnce("metadataLoaded", function () {
						if (bSettled) {
							return;
						}
						bSettled = true;
						clearTimeout(iTimer);
						fnRead().then(resolve, reject);
					});
				});
			});
		},

		/**
		 * As {@link read}, for an entity set not every backend has. The project areas
		 * (Task, Proj_Task_Assign_Text) are missing from some systems' services
		 * altogether - the demo one among them - and reading one there is a 404 that
		 * took every other value help on the page down with it. Where the service
		 * has no such set this resolves with no rows, without a request; where it
		 * has one, a failure is still reported as usual.
		 * @param {sap.ui.model.odata.v2.ODataModel} oModel the OData model
		 * @param {string} sPath the entity set path
		 * @param {object} [mParameters] read parameters (filters, urlParameters, ...)
		 * @returns {Promise<object>} the response, or { results: [] }
		 */
		readOptional: function (oModel, sPath, mParameters) {
			return this.read(oModel, sPath, mParameters, true);
		},

		/**
		 * Only meaningful once the service metadata has loaded.
		 * @param {sap.ui.model.odata.v2.ODataModel} oModel the OData model
		 * @param {string} sPath an entity set path, e.g. "/Task" or "/Task('x')"
		 * @returns {boolean} true when the service has that entity set
		 */
		hasEntitySet: function (oModel, sPath) {
			var sName = String(sPath).replace(/^\//, "").split(/[(/]/)[0];
			var oMetadata = oModel.getServiceMetadata && oModel.getServiceMetadata();
			var aSchemas = (oMetadata && oMetadata.dataServices && oMetadata.dataServices.schema) || [];

			return aSchemas.some(function (oSchema) {
				return (oSchema.entityContainer || []).some(function (oContainer) {
					return (oContainer.entitySet || []).some(function (oSet) {
						return oSet.name === sName;
					});
				});
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
		/**
		 * The days in a range that can still be booked as leave, from the leave
		 * service's getDates - with the half-booked days it leaves out put back.
		 *
		 * getDates is meant to return a day with one half already taken with only the
		 * other half free (availableSlot "AM" or "PM"), and every booking form here is
		 * built for that. It drops such a day altogether instead, so once the morning
		 * of a day was booked its afternoon could never be. The person's own leave says
		 * which half is taken, so the day is offered again with just the free half.
		 * @param {object} oParams getDates' parameters: FromDate, ToDate, OrgID, SiteID, EmpID
		 * @param {string} [sEmail] whose leave it is, to read which halves they have taken
		 * @returns {Promise<object>} the getDates response, its dates in order
		 */
		leaveDates: function (oParams, sEmail) {
			var pDates = this.getJson(this.query(this.LEAVE, Object.assign({ cmd: "getDates" }, oParams)));
			// Without the person's leave the service's answer stands as it was.
			var pLeaves = sEmail
				? this.getJson(this.query(this.LEAVE, { cmd: "fetchUser", Email: sEmail, OrgID: oParams.OrgID }))
					.then(function (oData) {
						return oData.availedLeaves || [];
					}, function () {
						return [];
					})
				: Promise.resolve([]);

			return Promise.all([pDates, pLeaves]).then(function (aResults) {
				var oData = aResults[0] || {};
				return Object.assign({}, oData, {
					dates: this.withFreeHalves(oData.dates || [], aResults[1], oParams.FromDate, oParams.ToDate)
				});
			}.bind(this));
		},

		/**
		 * @param {Array<object>} aDates the days getDates offered
		 * @param {Array<object>} aLeaves the person's own leave (Date, Absence, StatusID)
		 * @param {string} sFrom the first day of the range, yyyy-MM-dd
		 * @param {string} sTo the last day of the range, yyyy-MM-dd
		 * @returns {Array<object>} the offered days plus each day in the range with only
		 * one half taken, offering the other half, in date order
		 */
		withFreeHalves: function (aDates, aLeaves, sFrom, sTo) {
			var mOffered = {};
			aDates.forEach(function (oDay) {
				mOffered[oDay.date] = true;
			});

			var mTaken = {};
			this.countedLeaves(aLeaves).forEach(function (oLeave) {
				var sDate = this.dayKey(oLeave.Date);
				if (!sDate || sDate < sFrom || sDate > sTo || mOffered[sDate]) {
					return;
				}
				var oTaken = mTaken[sDate] = mTaken[sDate] || {};
				oTaken[oLeave.Absence === "AM" || oLeave.Absence === "PM" ? oLeave.Absence : "Full"] = true;
			}, this);

			var aFreeHalves = Object.keys(mTaken).filter(function (sDate) {
				var oTaken = mTaken[sDate];
				return !oTaken.Full && !!oTaken.AM !== !!oTaken.PM;
			}).map(function (sDate) {
				var aParts = sDate.split("-");
				var oDate = new Date(+aParts[0], +aParts[1] - 1, +aParts[2]);
				return {
					date: sDate,
					displayDate: oDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
					day: oDate.getDay(),
					dayName: oDate.toLocaleDateString("en-GB", { weekday: "short" }),
					availableSlot: mTaken[sDate].AM ? "PM" : "AM"
				};
			});

			return aDates.concat(aFreeHalves).sort(function (a, b) {
				return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
			});
		},

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
