sap.ui.define([
	"sap/m/ColumnListItem",
	"sap/m/ColumnListItemRenderer"
], function (ColumnListItem, ColumnListItemRenderer) {
	"use strict";

	/**
	 * A timesheet grid row that can be left out of the table's selection.
	 *
	 * BlueStoneX's own projects and the leave and bank holiday rows are never the
	 * user's to delete, so they must not take part in "select all". The table used to
	 * let them be selected and then take the selection back in its selectionChange
	 * handler - which left the select-all checkbox forever unticked, because the
	 * table still counted those rows as selectable and so never saw every selectable
	 * row selected.
	 *
	 * Selectability is what select-all, the header checkbox and Ctrl+A all ask the
	 * row about, and ListItemBase documents isSelectable as the method a subclass
	 * overrides for an unselectable item. The row is still rendered in selection
	 * mode, so its checkbox cell keeps the columns in line (style.css hides the box
	 * itself); overriding getMode instead, as GroupHeaderListItem does, would drop
	 * that cell and slide the rest of the row one column to the left.
	 */
	return ColumnListItem.extend("bsx.hrx.hrx2026.control.TimesheetRow", {
		metadata: {
			properties: {
				/**
				 * Whether the row can be selected - false for rows that may not be
				 * deleted.
				 */
				selectable: { type: "boolean", defaultValue: true }
			}
		},

		renderer: ColumnListItemRenderer,

		isSelectable: function () {
			return this.getSelectable() && ColumnListItem.prototype.isSelectable.apply(this, arguments);
		}
	});
});
