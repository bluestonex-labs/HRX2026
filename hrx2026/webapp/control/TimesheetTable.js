sap.ui.define([
	"sap/m/Table",
	"sap/m/TableRenderer"
], function (Table, TableRenderer) {
	"use strict";

	/**
	 * The timesheet grid, with a select-all checkbox that tells the truth when nothing
	 * on the sheet can be selected.
	 *
	 * sap.m.Table ticks select-all whenever the number of selected rows equals the
	 * number of selectable ones. A week holding only BlueStoneX's own projects and
	 * leave has no selectable rows at all (see TimesheetRow), so that reads 0 == 0 and
	 * the box shows ticked with nothing selected - and nothing it could select. The
	 * box is switched off for as long as that is the case.
	 */
	return Table.extend("bsx.hrx.hrx2026.control.TimesheetTable", {
		metadata: {},

		renderer: TableRenderer,

		/**
		 * The table calls this after every change that could move the checkbox:
		 * select all, clear, a single row ticked or unticked, and each time the rows
		 * binding updates. It is documented as protected, for subclasses to extend.
		 */
		updateSelectAllCheckbox: function () {
			Table.prototype.updateSelectAllCheckbox.apply(this, arguments);

			// The field rather than _getSelectAllCheckbox(): the getter creates the box
			// and then calls straight back into this method.
			var oCheckBox = this._selectAllCheckBox;
			if (!oCheckBox || this.getMode() !== "MultiSelect") {
				return;
			}

			var bAnySelectable = this.getItems().some(function (oItem) {
				return oItem.isSelectable();
			});

			oCheckBox.setEnabled(bAnySelectable);
			if (!bAnySelectable) {
				oCheckBox.setSelected(false);
				// The base method has already announced the header as selected.
				this.$("tblHeader").find(".sapMTblCellFocusable").addBack().attr("aria-selected", false);
			}
		}
	});
});
