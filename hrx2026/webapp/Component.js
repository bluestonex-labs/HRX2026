sap.ui.define([
    "sap/ui/core/UIComponent",
    "bsx/hrx/hrx2026/model/models",
    "bsx/hrx/hrx2026/model/CurrentUser"
], (UIComponent, models, CurrentUser) => {
    "use strict";

    return UIComponent.extend("bsx.hrx.hrx2026.Component", {
        metadata: {
            manifest: "json",
            interfaces: [
                "sap.ui.core.IAsyncContentCreation"
            ]
        },

        init() {
            // call the base component's init function
            UIComponent.prototype.init.apply(this, arguments);

            // set the device model
            this.setModel(models.createDeviceModel(), "device");

            // Seed the shared profile promise before routing starts. App.controller's
            // own health-strip fetch and Home.controller's landing-page fetch both key
            // off oComponent._pProfile - created only after a route has already
            // matched, each would race to resolve the profile on its own and fire its
            // service calls (leaveReqs fetchUser, timesheet fetch) with an empty or
            // undefined email/orgId before the real lookup lands.
            this._pProfile = this._getLoggedinUserEmail().then(function (sEmail) {
                return CurrentUser.load(this, sEmail);
            }.bind(this)).catch(function (oError) {
                // CurrentUser.load() already falls back to a no-identity profile on its
                // own service failures, but its setup work (reading startup parameters)
                // runs before that safety net and can still throw. _pProfile must never
                // reject: every consumer (App.controller's shell, Home.controller's
                // landing-page fetch) awaits it with no catch of its own, so a rejection
                // here would silently strand the whole page on its post-reset blank state.
                console.error("Profile resolution failed, falling back to no identity", oError);
                var sOrgId;
                try {
                    sOrgId = CurrentUser.orgId(this);
                } catch (oOrgIdError) {
                    sOrgId = "BSX";
                }
                return {
                    email: "",
                    orgId: sOrgId,
                    empID: "",
                    name: "",
                    initials: "",
                    siteID: "",
                    isManager: false,
                    hasPendingLeave: false
                };
            }.bind(this));

            // enable routing
            this.getRouter().initialize();
        },

        /**
         * @returns {Promise<string>} the signed-in user's email, from the approuter's
         * authenticated session, or "" if it could not be resolved
         */
        _getLoggedinUserEmail() {
            // xs-app.json only routes "/user-api/(.*)" at the approuter root - a URL
            // built from the app's own resource path (via getModulePath) lands under
            // .../<appId>-.../user-api/currentUser instead, which that route never
            // matches, so the call 404s and every session falls back to no identity.
            var id = this.getManifestEntry("/sap.app/id");
            var callUrl = jQuery.sap.getModulePath(id + '/user-api/currentUser');

            // A native promise, not $.ajax's own: a jQuery promise propagates the value
            // its fail handler returns as a *rejection* rather than a resolution, so the
            // "" fallback below used to come back rejected. That rejection survived the
            // .catch in init() (jQuery semantics again) and left _pProfile rejected -
            // which is what surfaced as "Home _onRouteMatched failed" with no reason
            // attached whenever /user-api/currentUser 404s, i.e. on every local run,
            // where there is no approuter in front of the app to answer it.
            return new Promise(function (resolve) {
                $.ajax({
                    url: callUrl,
                    type: "GET",
                    contentType: "application/json",
                    dataType: "json",
                    cache: false
                }).done(function (oData) {
                    resolve((oData && oData.email) || "");
                }).fail(function (jqXHR) {
                    console.log(jqXHR.responseText);
                    resolve("");
                });
            });
        }
    });
});