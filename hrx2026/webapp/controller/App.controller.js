sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/core/Fragment",
	"sap/ui/Device",
	"../model/Backend",
	"../model/formatter"
], function (Controller, Fragment, Device, Backend, formatter) {
	"use strict";

	var mKeyToRoute = {
		home: "home",
		timesheet: "timesheet",
		leave: "leave",
		teamcal: "teamcal",
		explorer: "explorer",
		admin: "admin"
	};

	// Topbar title per route, so the page name appears once in the shell rather than
	// again inside every page.
	var mRouteToTitleKey = {
		home: "navHome",
		timesheet: "navTimesheet",
		leave: "navLeave",
		teamcal: "navTeamCalendar",
		resources: "navManageResources",
		clients: "navManageClients",
		projects: "navManageProjects",
		missingtimesheets: "navMissingTimesheets",
		explorer: "navAppExplorer",
		admin: "navAdmin"
	};

	// Which nav row to light up for the pages that are reached from the App Explorer.
	var mRouteToNavKey = {
		resources: "explorer",
		clients: "explorer",
		projects: "explorer",
		missingtimesheets: "explorer"
	};

	return Controller.extend("bsx.hrx.hrx2026.controller.App", {

		formatter: formatter,

		onInit: function () {
			var oToolPage = this.byId("toolPage");
			// start expanded on desktop, collapsed on smaller screens
			oToolPage.setSideExpanded(Device.resize.width > 1024);
			this._updateNavToggleIcon(oToolPage.getSideExpanded());

			this.getOwnerComponent().getRouter().attachRouteMatched(this._onRouteMatched, this);
		},

		/**
		 * Fills in who is signed in. The health strip's own figures come from the home
		 * page's own fetch instead - see setHealthStrip - rather than a second fetch of
		 * the same week/leave/approvals data here.
		 */
		_loadShell: function () {
			var oComponent = this.getOwnerComponent();
			var oModel = oComponent.getModel("app");

			// Component.init() already seeded this before routing started, so this -
			// and every routed page that needs the profile on its very first match,
			// the home page above all - shares the same resolution instead of each
			// racing to look the profile up on its own.
			var pUser = oComponent._pProfile;

			Promise.all([pUser, oModel.dataLoaded()]).then(function (aResult) {
				var oProfile = aResult[0];

				oModel.setProperty("/user", {
					name: oProfile.name,
					initials: oProfile.initials,
					email: oProfile.email,
					empID: oProfile.empID,
					isManager: oProfile.isManager,
					roleLabel: oProfile.empID
				});
			}.bind(this));
		},

		/**
		 * Called by the home page once it has loaded the week, leave and approvals data
		 * the strip summarises, so the numbers come from that one fetch rather than the
		 * shell fetching the same data again for itself.
		 * @param {Array<object>} aStrip the strip entries
		 */
		setHealthStrip: function (aStrip) {
			this.getOwnerComponent().getModel("app").setProperty("/healthStrip", aStrip);
			this._refreshStripVisibility();
		},

		getResourceBundle: function () {
			return this.getOwnerComponent().getModel("i18n").getResourceBundle();
		},

		getText: function (sKey, aArgs) {
			return this.getResourceBundle().getText(sKey, aArgs);
		},

		/**
		 * Reflects the route in the shell title and the side navigation selection.
		 * @param {sap.ui.base.Event} oEvent the routeMatched event
		 */
		_onRouteMatched: function (oEvent) {
			this._loadShell();
			
			var sRoute = oEvent.getParameter("name");
			var sKey = mRouteToTitleKey[sRoute];
			if (!sKey) {
				return;
			}

			this._sRoute = sRoute;

			// The app catalogue arrives asynchronously and replaces the whole model, so
			// the title is written once that has landed. Setting it earlier leaves a
			// deep link showing whatever title the catalogue was seeded with.
			var oModel = this.getOwnerComponent().getModel("app");
			oModel.dataLoaded().then(function () {
				oModel.setProperty("/page", { title: this.getText(sKey) });
				this._refreshStripVisibility();
			}.bind(this));

			var oNavList = this.byId("sideNavigation").getItem();
			if (oNavList) {
				oNavList.setSelectedKey(mRouteToNavKey[sRoute] || sRoute);
			}
		},

		/**
		 * The strip reports on the signed-in user's own week, so it is shown on the home
		 * page and nowhere else.
		 */
		_refreshStripVisibility: function () {
			var oModel = this.getOwnerComponent().getModel("app");
			var aStrip = oModel.getProperty("/healthStrip") || [];

			oModel.setProperty("/page/showStrip", this._sRoute === "home" && aStrip.length > 0);
		},

		/**
		 * Shows who is signed in. The rail no longer repeats the name, so this is where
		 * the details live.
		 * @param {sap.ui.base.Event} oEvent the avatar press event
		 */
		onProfilePress: function (oEvent) {
			var oAvatar = oEvent.getSource();

			if (!this._pProfilePopover) {
				this._pProfilePopover = Fragment.load({
					id: this.getView().getId(),
					name: "bsx.hrx.hrx2026.fragment.ProfilePopover",
					controller: this
				}).then(function (oPopover) {
					this.getView().addDependent(oPopover);
					return oPopover;
				}.bind(this));
			}

			this._pProfilePopover.then(function (oPopover) {
				oPopover.openBy(oAvatar);
			});
		},

		onMenuButtonPress: function () {
			var oToolPage = this.byId("toolPage");
			var bExpanded = !oToolPage.getSideExpanded();
			oToolPage.setSideExpanded(bExpanded);
			this._updateNavToggleIcon(bExpanded);
		},

		/**
		 * Collapsed, the toggle sits alone at the top of the narrow rail with no room
		 * for the wordmark, so it reads as the menu opener rather than a "back" arrow.
		 * @param {boolean} bExpanded the side rail's new expanded state
		 */
		_updateNavToggleIcon: function (bExpanded) {
			this.byId("navToggleButton").setIcon(bExpanded ? "sap-icon://navigation-left-arrow" : "sap-icon://menu2");
			this.byId("toolPage").toggleStyleClass("hrxSideCollapsed", !bExpanded);
		},

		onItemSelect: function (oEvent) {
			var sKey = oEvent.getParameter("item").getKey();
			this.getOwnerComponent().getRouter().navTo(mKeyToRoute[sKey] || "home");
		}
	});
});
