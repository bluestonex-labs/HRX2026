sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/m/MessageToast"
], function (Controller, MessageToast) {
	"use strict";

	return Controller.extend("bsx.hrx.hrx2026.controller.AppExplorer", {

		/**
		 * Opens the app the tile stands for. The route is part of the catalogue, so
		 * adding an app is a data change rather than a code change.
		 * @param {sap.ui.base.Event} oEvent the tile press event
		 */
		onTilePress: function (oEvent) {
			var oContext = oEvent.getSource().getBindingContext("app");
			if (!oContext) {
				return;
			}

			var sRoute = oContext.getProperty("route");
			if (sRoute) {
				this.getOwnerComponent().getRouter().navTo(sRoute);
			} else {
				MessageToast.show(oContext.getProperty("title"));
			}
		}
	});
});
