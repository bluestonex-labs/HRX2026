sap.ui.define([
	"sap/ui/core/library",
	"sap/ui/core/format/DateFormat"
], function (coreLibrary, DateFormat) {
	"use strict";

	var ValueState = coreLibrary.ValueState;

	var oDisplayDate = DateFormat.getDateInstance({ style: "medium" });

	/**
	 * The services hand dates back in three shapes: real Date objects (OData reads via
	 * the model), "/Date(<ms>)/" strings (raw OData JSON) and "yyyy-MM-dd" strings (the
	 * XS JavaScript services). This normalises all of them.
	 * @param {Date|string} vDate the value to interpret
	 * @returns {Date|null} the date, or null when it cannot be read
	 */
	function toDate(vDate) {
		if (!vDate || vDate === "None") {
			return null;
		}
		if (vDate instanceof Date) {
			return isNaN(vDate.getTime()) ? null : vDate;
		}

		var aTicks = /^\/Date\((-?\d+)\)\/$/.exec(vDate);
		var oDate = new Date(aTicks ? parseInt(aTicks[1], 10) : vDate);

		return isNaN(oDate.getTime()) ? null : oDate;
	}

	return {

		toDate: toDate,

		/**
		 * @param {Date|string} vDate any date shape the services return
		 * @returns {string} the date for display, empty when there is none
		 */
		date: function (vDate) {
			var oDate = toDate(vDate);
			return oDate ? oDisplayDate.format(oDate) : "";
		},

		/**
		 * @param {Date|string} vFrom validity start
		 * @param {Date|string} vTo validity end
		 * @returns {string} "from - to", or whichever end is known
		 */
		dateRange: function (vFrom, vTo) {
			var sFrom = toDate(vFrom) ? oDisplayDate.format(toDate(vFrom)) : "";
			var sTo = toDate(vTo) ? oDisplayDate.format(toDate(vTo)) : "";

			if (sFrom && sTo) {
				return sFrom + " – " + sTo;
			}
			return sFrom || sTo || "";
		},

		/**
		 * @param {string} sFlag a Y/N flag
		 * @returns {string} an accept or decline icon
		 */
		flagIcon: function (sFlag) {
			return sFlag === "Y" ? "sap-icon://accept" : "sap-icon://decline";
		},

		/**
		 * @param {string} sFlag a Y/N flag
		 * @returns {sap.ui.core.ValueState} success when set, error otherwise
		 */
		flagState: function (sFlag) {
			return sFlag === "Y" ? ValueState.Success : ValueState.Error;
		},

		/**
		 * @param {string} sFlag a Y/N flag
		 * @returns {string} "Yes" or "No"
		 */
		flagText: function (sFlag) {
			return sFlag === "Y" ? "Yes" : "No";
		},

		/**
		 * The services return the string "None" where a value is missing.
		 * @param {string} sValue the raw value
		 * @returns {string} the value, or an empty string
		 */
		clean: function (sValue) {
			return (!sValue || sValue === "None" || sValue === "null") ? "" : sValue;
		},

		/**
		 * Avatars fall back to their initials only when src is unset - binding an empty
		 * string instead makes the browser request the current page as an image.
		 * @param {string} sSource the stored image, usually a data URI
		 * @returns {string|undefined} the image, or undefined when there is none
		 */
		imageSrc: function (sSource) {
			return (!sSource || sSource === "None") ? undefined : sSource;
		},

		/**
		 * Picks the freshly uploaded image over the stored one, falling back to no image
		 * at all so the avatar shows its initials.
		 * @param {string} sNewImage the image chosen in this session
		 * @param {string} sStoredImage the image held by the backend
		 * @returns {string|undefined} the image to show, or undefined
		 */
		pendingImageSrc: function (sNewImage, sStoredImage) {
			var sImage = sNewImage || sStoredImage;
			return (!sImage || sImage === "None") ? undefined : sImage;
		},

		/**
		 * @param {string|number} vAmount an amount
		 * @param {string} sCurrency the currency, defaults to GBP
		 * @returns {string} the amount with a currency symbol
		 */
		money: function (vAmount, sCurrency) {
			var fAmount = parseFloat(vAmount);
			if (isNaN(fAmount)) {
				return "";
			}
			var sSymbol = (!sCurrency || sCurrency === "GBP") ? "£" : sCurrency + " ";
			return sSymbol + fAmount.toLocaleString("en-GB", { maximumFractionDigits: 2 });
		},

		/**
		 * Initials for an organisation-style name, e.g. "Bluestonex Consulting" -> "BC".
		 * @param {string} sName the name
		 * @returns {string} up to two upper case initials
		 */
		nameInitials: function (sName) {
			var aWords = (sName || "").trim().split(/\s+/).filter(Boolean);
			if (!aWords.length) {
				return "?";
			}
			return (aWords[0].charAt(0) + (aWords.length > 1 ? aWords[1].charAt(0) : "")).toUpperCase();
		},

		/**
		 * Maps a leave request status id onto a value state for ObjectStatus.
		 * @param {string} sStatusId status id as returned by leaveReqs.xsjs
		 * @returns {sap.ui.core.ValueState} the matching value state
		 */
		leaveStatusState: function (sStatusId) {
			switch (sStatusId) {
				case "APR":
					return ValueState.Success;
				case "REJ":
					return ValueState.Error;
				case "REQ":
					return ValueState.Warning;
				default:
					return ValueState.None;
			}
		},

		/**
		 * Builds the avatar initials from a resource's first and last name.
		 * @param {string} sFirstName first name
		 * @param {string} sLastName last name
		 * @returns {string} up to two upper case initials
		 */
		initials: function (sFirstName, sLastName) {
			var sFirst = (sFirstName || "").trim().charAt(0);
			var sLast = (sLastName || "").trim().charAt(0);
			return (sFirst + sLast).toUpperCase() || "?";
		},

		/**
		 * @param {string} sUserTypeKey the user type key (S/C)
		 * @returns {string} the readable user type
		 */
		userTypeText: function (sUserTypeKey) {
			switch (sUserTypeKey) {
				case "S":
					return "Staff";
				case "C":
					return "Contractor";
				default:
					return sUserTypeKey || "";
			}
		},

		/**
		 * @param {string} sIsActive the active flag (Y/N)
		 * @returns {sap.ui.core.ValueState} success when active, warning otherwise
		 */
		activeState: function (sIsActive) {
			return sIsActive === "Y" ? ValueState.Success : ValueState.Warning;
		},

		/**
		 * @param {string} sIsActive the active flag (Y/N)
		 * @returns {string} readable active text
		 */
		activeText: function (sIsActive) {
			return sIsActive === "Y" ? "Active" : "Inactive";
		},

		/**
		 * Colour used for a leave type in the leave breakdown chart.
		 * @param {string} sLeaveType the leave type description
		 * @returns {string} a CSS colour
		 */
		// Kept in step with the --sapLegendColor1-5 overrides in css/style.css, which
		// recolour the leave calendar's day markers and legend to the same palette.
		leaveTypeColor: function (sLeaveType) {
			switch ((sLeaveType || "").toLowerCase()) {
				case "holiday":
					return "#96C2FA";
				case "sick":
					return "#BB98C5";
				case "unpaid":
					return "#EB7F5D";
				case "compassionate":
					return "#F7CB48";
				case "bank holiday":
					return "#ABC3D2";
				default:
					return "#8C8C8C";
			}
		},

		/**
		 * @param {string} sBooked hours booked this week
		 * @param {string} sTarget hours the week expects
		 * @returns {string} e.g. "12:30 of 40:00 hrs"
		 */
		hoursOfTarget: function (sBooked, sTarget) {
			return (sBooked || "0:00") + " of " + (sTarget || "0:00") + " hrs";
		},

		/**
		 * Colours the work-description button of a timesheet cell: red while a booking
		 * still has no description, green once it has one.
		 * @param {string} sTime the booked time
		 * @param {string} sComment the work description
		 * @returns {string} a button type
		 */
		commentState: function (sTime, sComment) {
			if (sTime && !sComment) {
				return "Reject";
			}
			return sComment ? "Accept" : "Transparent";
		},

		/**
		 * Subtitle for a calendar row.
		 * @param {number} iDays number of leave entries in the shown period
		 * @returns {string} a readable summary
		 */
		leaveDaysText: function (iDays) {
			if (!iDays) {
				return "No leave booked";
			}
			return iDays === 1 ? "1 day away" : iDays + " days away";
		},

		/**
		 * @param {Array} aItems any array from the model
		 * @returns {number} the number of entries
		 */
		count: function (aItems) {
			return (aItems || []).length;
		},

		/**
		 * @param {Array} aItems any array from the model
		 * @returns {boolean} true when the array is empty
		 */
		isEmptyList: function (aItems) {
			return (aItems || []).length === 0;
		},

		/**
		 * @param {Array} aItems any array from the model
		 * @returns {boolean} true when the array holds at least one entry
		 */
		hasItems: function (aItems) {
			return (aItems || []).length > 0;
		}
	};
});
