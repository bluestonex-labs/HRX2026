sap.ui.define([
	"./Backend"
], function (Backend) {
	"use strict";

	var DEFAULT_ORG_ID = "BSX";

	var oProfile = null;
	var pProfile = null;
	var bMissingIdentityReported = false;

	/**
	 * @param {sap.ui.core.UIComponent} oComponent the app component
	 * @returns {object} the startup parameters the launchpad passed in
	 */
	function startupParameters(oComponent) {
		var oComponentData = oComponent && oComponent.getComponentData();
		return (oComponentData && oComponentData.startupParameters) || {};
	}

	function firstOf(oParameters, sName) {
		return (oParameters[sName] && oParameters[sName].length && oParameters[sName][0]) || "";
	}

	/**
	 * Only a machine running the app off the development server has no identity to
	 * resolve. Anywhere else - a launchpad site, an approuter, a preview in BAS - an
	 * email that could not be read means something is wrong with the session, and
	 * standing in a colleague's shoes is far worse than showing nothing: that is what
	 * put somebody else's leave balance and timesheet on screen after a refresh.
	 * @returns {boolean} true when the app is being served locally
	 */
	function isLocalRun() {
		var sHost = (window.location && window.location.hostname) || "";
		return sHost === "localhost" || sHost === "127.0.0.1" || sHost === "[::1]" || sHost === "";
	}

	return {

		/**
		 * Only meaningful once {@link load} has resolved - before that, there is no
		 * signed-in user to report yet, so this answers the same launchpad startup
		 * parameter {@link load} starts from.
		 * @param {sap.ui.core.UIComponent} oComponent the app component
		 * @returns {string} the signed-in user's email
		 */
		email: function (oComponent) {
			if (oProfile) {
				return oProfile.email;
			}
			return firstOf(startupParameters(oComponent), "email").toLowerCase();
		},

		/**
		 * Two emails for the same person can differ in case - the services answer with
		 * an upper-cased one, /Resources stores a lower-cased one - so they are only
		 * ever compared through here.
		 * @param {string} sLeft one email
		 * @param {string} sRight the other
		 * @returns {boolean} true when both name the same person
		 */
		sameEmail: function (sLeft, sRight) {
			return !!sLeft && !!sRight && sLeft.toLowerCase() === sRight.toLowerCase();
		},

		/**
		 * @param {sap.ui.core.UIComponent} oComponent the app component
		 * @returns {string} the organisation to read data for
		 */
		orgId: function (oComponent) {
			return firstOf(startupParameters(oComponent), "org") || DEFAULT_ORG_ID;
		},

		/**
		 * Loads who is signed in, and whether they manage anybody. The team service
		 * already answers both from one call, so that is the single place the suite
		 * decides on manager rights - when the dedicated identity service arrives, this
		 * is the only method that has to change.
		 *
		 * The email itself comes from, in order: a launchpad startup parameter (the
		 * only way to set it when previewing from BAS, since there is no approuter in
		 * front of a local preview to authenticate a session), then whatever email the
		 * caller has already resolved from the approuter's authenticated session
		 * (App.controller's getLoggedinUser1, once the app is actually deployed).
		 *
		 * The profile is loaded once and shared, so navigating between pages does not
		 * fetch it again.
		 * @param {sap.ui.core.UIComponent} oComponent the app component
		 * @param {string} [sEmail] the signed-in user's email, if the caller already knows it
		 * @returns {Promise<object>} the signed-in user's profile
		 */
		load: function (oComponent, sEmail) {
			if (pProfile) {
				return pProfile;
			}

			var sParamEmail = firstOf(startupParameters(oComponent), "email");
			var sOrgId = this.orgId(oComponent);
			var sToday = Backend.isoDate(new Date());

			// A local run has no approuter and no launchpad in front of it, so there is
			// no startup parameter and no authenticated session to resolve an email
			// from - it falls back to a dev identity so the app is usable on a laptop.
			// A deployment must never do that: an unresolved email there means the
			// session is broken, and loading somebody else's data instead is the bug
			// that surfaced as "refreshing My Leave shows another person's details".
			//
			// Lower cased once, here, so nothing downstream has to think about it. The
			// xsjs services match an email whatever its case, but the OData /Resources
			// filter does not, and the identity the launchpad and the team service hand
			// back is sometimes upper case - which silently left the work schedule on
			// its Mon-Fri fallback and dropped the signed-in user out of their own
			// "viewing as" directory.
			var sResolvedEmail = (sParamEmail || sEmail ||
				(isLocalRun() ? "gaurav.kumar@bluestonex.com" : "")).toLowerCase();

			pProfile = Promise.resolve(sResolvedEmail).then(function (sResolvedEmail) {
				if (!sResolvedEmail) {
					// No identity to look up - asking the TEAM service for an empty Email
					// does not mean "nobody", it means "match anybody", so it must never be
					// sent. Go straight to the same no-identity profile the catch below
					// falls back to on a service failure.
					pProfile = null;
					oProfile = {
						email: "",
						orgId: sOrgId,
						empID: "",
						name: "",
						initials: "",
						siteID: "",
						isManager: false,
						hasPendingLeave: false
					};
					return oProfile;
				}

				var sEmail = sResolvedEmail;

				// The date range only bounds the leave the service returns alongside the
				// user, so a single day keeps the response small.
				return Backend.getJson(Backend.query(Backend.TEAM, {
					cmd: "team",
					OrgID: sOrgId,
					Email: sEmail,
					FromDate: sToday,
					ToDate: sToday
				})).then(function (oData) {
					var oUser = (oData.loggedinUser || [])[0] || {};
					var sName = oUser.Name || sEmail;

					oProfile = {
						email: sEmail,
						orgId: sOrgId,
						empID: oUser.EmpID || "",
						name: sName,
						initials: sName.split(/\s+/).map(function (sPart) {
							return sPart.charAt(0).toUpperCase();
						}).slice(0, 2).join(""),
						siteID: oUser.SiteID || "",
						isManager: oUser.IsManager === "Y",
						hasPendingLeave: oUser.HasPendingLeaves === "Y"
					};
					return oProfile;
				}).catch(function () {
					// A failed call must not stick for the rest of the session: drop the
					// cached attempt so the next caller tries again.
					pProfile = null;

					// Without the service the suite still has to render, so fall back to an
					// employee-level profile rather than failing the whole shell.
					oProfile = {
						email: sEmail,
						orgId: sOrgId,
						empID: "",
						name: sEmail,
						initials: sEmail.charAt(0).toUpperCase(),
						siteID: "",
						isManager: false,
						hasPendingLeave: false
					};
					return oProfile;
				});
			});

			return pProfile;
		},

		/**
		 * The one place a controller should wait on before it fetches anything for the
		 * signed-in user. Component.init() seeds the lookup before routing starts, so
		 * this is that same shared promise rather than a second resolution - and it
		 * never rejects.
		 *
		 * Reading the email synchronously in onInit (as every page used to) is what
		 * broke a browser refresh: onInit runs while the lookup is still in flight, so
		 * the email came back "", which the services read as "match anybody" - the
		 * timesheet lost its projects and kept only the bank holiday row, and My Leave
		 * filled in with whoever the service answered with.
		 * @param {sap.ui.core.UIComponent} oComponent the app component
		 * @returns {Promise<object>} the signed-in user's profile
		 */
		ready: function (oComponent) {
			if (oComponent && oComponent._pProfile) {
				return Promise.resolve(oComponent._pProfile);
			}
			return this.load(oComponent);
		},

		/**
		 * Every page notices a session with no identity and every page wants to say so,
		 * which on its own means a fresh error dialog on each one - and another every
		 * time the user comes back to a page they have already seen. It is one problem
		 * with one answer ("sign in again"), so it is reported once.
		 * @returns {boolean} true the first time it is asked, false afterwards
		 */
		shouldReportMissingIdentity: function () {
			if (bMissingIdentityReported) {
				return false;
			}
			bMissingIdentityReported = true;
			return true;
		},

		/**
		 * @returns {object|null} the profile, once loaded
		 */
		get: function () {
			return oProfile;
		}
	};
});
