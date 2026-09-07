sap.ui.define([
	"sap/ui/core/mvc/Controller"
], function (Controller) {
	"use strict";

	return Controller.extend("bsx.hrx.hrx2026.controller.Admin", {

		/**
		 * Opens the management app the tile stands for.
		 * @param {sap.ui.base.Event} oEvent the tile press event
		 */
		onTilePress: function (oEvent) {
			var oContext = oEvent.getSource().getBindingContext("app");
			var sRoute = oContext && oContext.getProperty("route");

			if (sRoute) {
				this.getOwnerComponent().getRouter().navTo(sRoute);
			}
		}
	});
});
