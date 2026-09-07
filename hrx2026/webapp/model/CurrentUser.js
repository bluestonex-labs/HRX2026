sap.ui.define([
	"./Backend"
], function (Backend) {
	"use strict";

	var DEFAULT_ORG_ID = "BSX";

	var oProfile = null;
	var pProfile = null;

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
			return firstOf(startupParameters(oComponent), "email");
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

			// Launchpad dev preview has no approuter in front of it, so there is no
			// startup parameter and no authenticated session to resolve an email from -
			// fall back to the same dev identity already hardcoded elsewhere for local
			// testing. A real deployment always resolves a real email here, so this
			// branch never fires there.
			var sResolvedEmail = sParamEmail || sEmail || "gaurav.kumar@bluestonex.com";

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
		 * @returns {object|null} the profile, once loaded
		 */
		get: function () {
			return oProfile;
		}
	};
});
