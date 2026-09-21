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

            // Every rule in css/style.css is qualified by this class rather than by
            // .sapUiBody, so the HRX restyle only ever reaches controls rendered while
            // this app is up - including dialogs and popovers, which UI5 renders in the
            // static area outside the app's own root control and which a class on that
            // root would therefore never cover. exit() takes it off again, so a
            // launchpad session that leaves HRX for another app is handed back an
            // untouched theme even though the stylesheet itself stays cached.
            document.body.classList.add("hrxApp");

            // set the device model
            this.setModel(models.createDeviceModel(), "device");

            this._retryMetadataOnFailure();

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

        exit() {
            document.body.classList.remove("hrxApp");
            UIComponent.prototype.exit.apply(this, arguments);
        },

        /**
         * An ODataModel reads $metadata once. If that one request fails - a dropped
         * connection, a gateway hiccup, the service still waking up - the model has no
         * metadata for the rest of the session and every read against it fails from
         * then on. That is how the leave type picker on the dashboard, the resource
         * directory behind "viewing as" and the work schedules all came to be empty at
         * the same time while the xsjs-backed parts of the same page were fine.
         *
         * A handful of spaced-out retries turns that permanent, session-long failure
         * back into a slow start.
         */
        _retryMetadataOnFailure() {
            var oModel = this.getModel();
            if (!oModel || typeof oModel.attachMetadataFailed !== "function") {
                return;
            }

            var iAttempt = 0;
            var iMaxAttempts = 3;

            oModel.attachMetadataFailed(function () {
                if (iAttempt >= iMaxAttempts) {
                    console.error("Service metadata could not be loaded after " + iMaxAttempts +
                        " attempts; lists backed by it will stay empty.");
                    return;
                }

                iAttempt++;
                // Backs off so a service that is still starting up is given time,
                // rather than being hammered: 1s, then 2s, then 4s.
                setTimeout(function () {
                    oModel.refreshMetadata();
                }, Math.pow(2, iAttempt - 1) * 1000);
            });

            // A later success means the trouble was transient, so a fresh outage gets
            // its own full set of retries.
            oModel.attachMetadataLoaded(function () {
                iAttempt = 0;
            });
        },

        /**
         * Resolves who is signed in, from the launchpad first and the approuter second.
         *
         * Both are tried in turn because neither is always there: the launchpad's own
         * UserInfo service is the authority whenever the app runs inside a site (which
         * is how everybody actually opens it), and /user-api/currentUser answers when
         * the app is served by an approuter of its own.
         * @returns {Promise<string>} the signed-in user's email, or "" if it could not
         * be resolved
         */
        _getLoggedinUserEmail() {
            return this._emailFromLaunchpad().then(function (sEmail) {
                return sEmail || this._emailFromUserApi();
            }.bind(this));
        },

        /**
         * @returns {Promise<string>} the email the launchpad shell holds for the signed-in
         * user, or "" when the app is not running inside one
         */
        _emailFromLaunchpad() {
            var oContainer = sap.ushell && sap.ushell.Container;
            if (!oContainer || typeof oContainer.getServiceAsync !== "function") {
                return Promise.resolve("");
            }

            return oContainer.getServiceAsync("UserInfo").then(function (oUserInfo) {
                return (oUserInfo && oUserInfo.getEmail && oUserInfo.getEmail()) || "";
            }).catch(function () {
                return "";
            });
        },

        /**
         * @returns {Promise<string>} the email the approuter's user API reports, or ""
         */
        _emailFromUserApi() {
            // xs-app.json routes "^/user-api(.*)" at the approuter *root*. A url built
            // from the app's own resource path (jQuery.sap.getModulePath) lands under
            // .../<appId>-<version>/user-api/currentUser instead, which that route never
            // matches - so the call 404s and the session is left with no identity at
            // all. The root-relative path is the one the approuter actually answers; the
            // module-relative one is still tried afterwards for the rare setup that
            // mounts the app behind its own approuter on a sub-path.
            var sAppId = this.getManifestEntry("/sap.app/id");
            var aCandidates = ["/user-api/currentUser"];

            if (sAppId && jQuery.sap && jQuery.sap.getModulePath) {
                aCandidates.push(jQuery.sap.getModulePath(sAppId + "/user-api/currentUser"));
            }

            // A native promise, not $.ajax's own: a jQuery promise propagates the value
            // its fail handler returns as a *rejection* rather than a resolution, so the
            // "" fallback below used to come back rejected. That rejection survived the
            // .catch in init() (jQuery semantics again) and left _pProfile rejected -
            // which is what surfaced as "Home _onRouteMatched failed" with no reason
            // attached whenever /user-api/currentUser 404s, i.e. on every local run,
            // where there is no approuter in front of the app to answer it.
            return aCandidates.reduce(function (pChain, sUrl) {
                return pChain.then(function (sEmail) {
                    if (sEmail) {
                        return sEmail;
                    }
                    return new Promise(function (resolve) {
                        $.ajax({
                            url: sUrl,
                            type: "GET",
                            contentType: "application/json",
                            dataType: "json",
                            cache: false
                        }).done(function (oData) {
                            resolve((oData && oData.email) || "");
                        }).fail(function () {
                            resolve("");
                        });
                    });
                });
            }, Promise.resolve(""));
        }
    });
});