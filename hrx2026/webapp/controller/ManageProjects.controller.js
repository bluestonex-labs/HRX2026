sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/core/Fragment",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/m/MessageToast",
	"sap/m/MessageBox",
	"../model/Backend",
	"../model/CurrentUser",
	"../model/formatter"
], function (Controller, Fragment, JSONModel, Filter, FilterOperator, MessageToast, MessageBox, Backend, CurrentUser, formatter) {
	"use strict";

	// Root path of the backend services - see xs-app.json (deployed) and ui5.yaml (local).
	var SERVICE_ROOT = Backend.SERVICE_ROOT;

	var PROJECTS_SERVICE = SERVICE_ROOT + "/hrx/manageProjects.xsjs";
	var ASSIGNMENTS_SERVICE = SERVICE_ROOT + "/hrx/manageAssignments.xsjs";
	var ATTACHMENTS_SERVICE = SERVICE_ROOT + "/hrx/manageAttachments.xsjs";
	var CLIENT_USERS_SERVICE = SERVICE_ROOT + "/supportx/ManageClientUsers.xsjs";
	var SUPPORT_ASSIGNMENTS_SERVICE = SERVICE_ROOT + "/supportx/ManageAssignments.xsjs";

	// The project list does not need the client logo, which is a base64 blob.
	var LIST_FIELDS = [
		"OrgID", "ProjectKey", "ProjectDesc", "ClientKey", "ProjectTypeKey", "StartDate",
		"EndDate", "PriorityKey", "PONumber", "POValue", "IsTimeBookingAllowed",
		"ProjectManagerID", "TotBillableDays", "ClientDesc", "ClientLocation"
	];

	return Controller.extend("bsx.hrx.hrx2026.controller.ManageProjects", {

		formatter: formatter,

		/* =========================================================== */
		/* lifecycle                                                   */
		/* =========================================================== */

		onInit: function () {
			this._sOrgId = this._resolveOrgId();

			this.setModel(new JSONModel({
				layout: "OneColumn",
				fullScreen: false,
				listBusy: true,
				detailBusy: false,
				tabBusy: false,
				saving: false,
				title: this.getText("mpListTitle"),
				searchQuery: "",
				selectedId: null,
				selectedTab: "info",
				filter: this._defaultFilter(),
				filterDraft: this._defaultFilter()
			}), "mpView");

			this.setModel(new JSONModel({
				allProjects: [],
				projects: [],
				clients: [],
				projectTypes: [],
				priorities: [],
				managers: [],
				billing: [],
				tasks: []
			}), "mp");

			this.setModel(new JSONModel({}), "mpDetail");
			this.setModel(new JSONModel(this._emptyTabs()), "mpTabs");
			this.setModel(new JSONModel({}), "mpForm");

			this._pLookupsLoaded = this._loadLookups();

			this.getOwnerComponent().getRouter().getRoute("projects")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		/**
		 * The view is reused across navigations, so entering the app always returns to
		 * the project list rather than to whatever was open before.
		 */
		_onRouteMatched: function () {
			var oViewModel = this.getModel("mpView");
			oViewModel.setProperty("/searchQuery", "");
			oViewModel.setProperty("/filter", this._defaultFilter());
			oViewModel.setProperty("/filterDraft", this._defaultFilter());
			this._closeDetail();
			this._pLookupsLoaded.then(this._loadProjects.bind(this));
		},

		/* =========================================================== */
		/* data loading                                                */
		/* =========================================================== */

		_loadLookups: function () {
			var oModel = this.getModel("mp");

			return Promise.all([
				this._read("/Clients", { filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)] }),
				this._read("/ProjectTypes", { filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)] }),
				this._read("/Priorities", { filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)] }),
				this._read("/Resources", {
					urlParameters: { "$select": "EmpID,FName,LName,IsActive,UserTypeKey" },
					filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)]
				}),
				this._read("/PredefinedBilling", { filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)] }),
				this._read("/Task")
			]).then(function (aResults) {
				var aClients = this._strip(aResults[0]).sort(function (a, b) {
					return (a.ClientDesc || "").localeCompare(b.ClientDesc || "");
				});
				this._mClientNames = aClients.reduce(function (mNames, oClient) {
					mNames[oClient.ClientKey] = oClient.ClientDesc;
					return mNames;
				}, {});

				var aResources = this._strip(aResults[3])
					.filter(function (oResource) {
						return oResource.IsActive === "Y";
					})
					.map(function (oResource) {
						oResource.FullName = ((oResource.FName || "") + " " + (oResource.LName || "")).trim();
						return oResource;
					})
					.sort(function (a, b) {
						return a.FullName.localeCompare(b.FullName);
					});
				this._mResourceNames = aResources.reduce(function (mNames, oResource) {
					mNames[oResource.EmpID] = oResource.FullName;
					return mNames;
				}, {});

				oModel.setProperty("/clients", aClients);
				oModel.setProperty("/projectTypes", this._strip(aResults[1]));
				oModel.setProperty("/priorities", this._strip(aResults[2]));
				oModel.setProperty("/managers", aResources);
				oModel.setProperty("/billing", this._strip(aResults[4]));
				oModel.setProperty("/tasks", this._strip(aResults[5]).sort(function (a, b) {
					return (a.TaskDesc || "").localeCompare(b.TaskDesc || "");
				}));
			}.bind(this)).catch(function (oError) {
				this._showError("mpErrorLookups", oError);
			}.bind(this));
		},

		_loadProjects: function () {
			var oViewModel = this.getModel("mpView");
			oViewModel.setProperty("/listBusy", true);

			return this._read("/ProjectsData", {
				urlParameters: { "$select": LIST_FIELDS.join(",") },
				filters: [new Filter("OrgID", FilterOperator.EQ, this._sOrgId)]
			}).then(function (oData) {
				this.getModel("mp").setProperty("/allProjects", this._strip(oData));
				this._applyListFilters();
				oViewModel.setProperty("/listBusy", false);
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/listBusy", false);
				this._showError("mpErrorProjects", oError);
			}.bind(this));
		},

		_applyListFilters: function () {
			var oViewModel = this.getModel("mpView");
			var oFilter = oViewModel.getProperty("/filter");
			var sQuery = (oViewModel.getProperty("/searchQuery") || "").trim().toLowerCase();

			var aFiltered = (this.getModel("mp").getProperty("/allProjects") || []).filter(function (oProject) {
				if (oFilter.client && oProject.ClientKey !== oFilter.client) {
					return false;
				}
				if (oFilter.timeBooking !== "A" && (oProject.IsTimeBookingAllowed || "N") !== oFilter.timeBooking) {
					return false;
				}
				if (sQuery) {
					return [oProject.ProjectDesc, oProject.ProjectKey, oProject.ClientDesc, oProject.PONumber]
						.join(" ").toLowerCase().indexOf(sQuery) !== -1;
				}
				return true;
			}).sort(function (a, b) {
				var iByClient = (a.ClientDesc || "").localeCompare(b.ClientDesc || "");
				return iByClient !== 0 ? iByClient : (a.ProjectDesc || "").localeCompare(b.ProjectDesc || "");
			});

			this.getModel("mp").setProperty("/projects", aFiltered);
			oViewModel.setProperty("/title", this.getText("mpListTitleCount", [aFiltered.length]));
		},

		/**
		 * Opens a project in the detail column.
		 * @param {object} oKeys the ProjectKey/ClientKey pair identifying the project
		 * @returns {Promise} resolved once the project is shown
		 */
		_showProject: function (oKeys) {
			var oViewModel = this.getModel("mpView");
			var oModel = this.getOwnerComponent().getModel();

			oViewModel.setProperty("/selectedId", oKeys.ProjectKey);
			oViewModel.setProperty("/selectedClientKey", oKeys.ClientKey);
			oViewModel.setProperty("/selectedTab", "info");
			oViewModel.setProperty("/layout", oViewModel.getProperty("/fullScreen") ? "MidColumnFullScreen" : "TwoColumnsMidExpanded");
			oViewModel.setProperty("/detailBusy", true);
			this.getModel("mpTabs").setData(this._emptyTabs());

			return oModel.metadataLoaded().then(function () {
				return Promise.all([
					this._read("/" + oModel.createKey("ProjectsData", {
						OrgID: this._sOrgId,
						ProjectKey: oKeys.ProjectKey,
						ClientKey: oKeys.ClientKey
					})),
					this._read("/Proj_Task_Assign_Text", {
						filters: [new Filter("ProjectKey", FilterOperator.EQ, oKeys.ProjectKey)]
					})
				]);
			}.bind(this)).then(function (aResults) {
				this.getModel("mpDetail").setData(this._toDetail(aResults[0], this._strip(aResults[1])));
				oViewModel.setProperty("/detailBusy", false);
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/detailBusy", false);
				this._closeDetail();
				this._showError("mpErrorProjectDetail", oError);
			}.bind(this));
		},

		_toDetail: function (oProject, aProjectTasks) {
			return {
				OrgID: oProject.OrgID || this._sOrgId,
				ProjectKey: oProject.ProjectKey,
				ProjectDesc: oProject.ProjectDesc || "",
				ClientKey: oProject.ClientKey,
				ClientDesc: oProject.ClientDesc || this._clientName(oProject.ClientKey),
				ClientLocation: oProject.ClientLocation || "",
				ProjectTypeKey: oProject.ProjectTypeKey || "",
				PriorityKey: oProject.PriorityKey || "",
				ProjectManagerID: oProject.ProjectManagerID || "",
				PONumber: oProject.PONumber || "",
				POValue: oProject.POValue || "",
				TotBillableDays: oProject.TotBillableDays || "",
				StartDate: formatter.toDate(oProject.StartDate),
				EndDate: formatter.toDate(oProject.EndDate),
				IsTimeBookingAllowed: oProject.IsTimeBookingAllowed || "N",
				TimeBooking: oProject.IsTimeBookingAllowed === "Y",
				// The project areas double as the pool an assignment can draw from.
				taskKeys: aProjectTasks.map(function (oTask) {
					return oTask.TaskKey;
				}),
				projectTasks: aProjectTasks
			};
		},

		_clientName: function (sClientKey) {
			return (this._mClientNames && this._mClientNames[sClientKey]) || sClientKey || "";
		},

		_resourceName: function (sEmpId) {
			return (this._mResourceNames && this._mResourceNames[sEmpId]) || sEmpId || "";
		},

		/* =========================================================== */
		/* tabs                                                        */
		/* =========================================================== */

		onTabSelect: function (oEvent) {
			this._loadTab(oEvent.getParameter("key"));
		},

		_loadTab: function (sKey) {
			var oViewModel = this.getModel("mpView");
			var sProjectKey = oViewModel.getProperty("/selectedId");
			if (!sProjectKey) {
				return Promise.resolve();
			}

			switch (sKey) {
				case "resourcing":
					return this._loadAssignments(sProjectKey);
				case "clientteam":
					return this._loadSupportTeam(oViewModel.getProperty("/selectedClientKey"), sProjectKey);
				case "attachments":
					return this._loadAttachments(sProjectKey);
				default:
					return Promise.resolve();
			}
		},

		_loadAssignments: function (sProjectKey) {
			return this._withTabBusy(this._getJson(ASSIGNMENTS_SERVICE + "?cmd=fetch&" + new URLSearchParams({
				orgID: this._sOrgId,
				projectKey: sProjectKey
			}).toString()).then(function (oData) {
				this.getModel("mpTabs").setProperty("/assignments", (oData.assignments || []).map(function (oAssignment) {
					oAssignment.FullName = ((oAssignment.Fname || oAssignment.FName || "") + " " +
						(oAssignment.Lname || oAssignment.LName || "")).trim();
					// TaskAssigned arrives as a JSON string on some rows and an array on others.
					if (typeof oAssignment.TaskAssigned === "string") {
						try {
							oAssignment.TaskAssigned = JSON.parse(oAssignment.TaskAssigned);
						} catch (oParseError) {
							oAssignment.TaskAssigned = [];
						}
					}
					oAssignment.TaskAssigned = oAssignment.TaskAssigned || [];
					return oAssignment;
				}));
			}.bind(this)), "mpErrorAssignments");
		},

		_loadSupportTeam: function (sClientKey, sProjectKey) {
			return this._withTabBusy(Promise.all([
				this._getJson(SUPPORT_ASSIGNMENTS_SERVICE + "?cmd=fetch&" + new URLSearchParams({
					OrgID: sClientKey,
					ProjectID: sProjectKey
				}).toString()),
				this._getJson(CLIENT_USERS_SERVICE + "?cmd=fetch&" + new URLSearchParams({
					OrgID: sClientKey
				}).toString())
			]).then(function (aResults) {
				this.getModel("mpTabs").setProperty("/supportTeam", aResults[0].users || []);
				this.getModel("mpTabs").setProperty("/clientUsers", (aResults[1].users || []).filter(function (oUser) {
					return oUser.IsActive === "Y";
				}));
			}.bind(this)), "mpErrorSupportTeam");
		},

		_loadAttachments: function (sProjectKey) {
			return this._withTabBusy(this._getJson(ATTACHMENTS_SERVICE + "?cmd=fetch&" + new URLSearchParams({
				OrgID: this._sOrgId,
				ProjectKey: sProjectKey
			}).toString()).then(function (oData) {
				this.getModel("mpTabs").setProperty("/attachments", oData.attachments || []);
			}.bind(this)), "mpErrorAttachments");
		},

		_withTabBusy: function (pWork, sErrorKey) {
			var oViewModel = this.getModel("mpView");
			oViewModel.setProperty("/tabBusy", true);

			return pWork.then(function () {
				oViewModel.setProperty("/tabBusy", false);
			}).catch(function (oError) {
				oViewModel.setProperty("/tabBusy", false);
				this._showError(sErrorKey, oError);
			}.bind(this));
		},

		/* =========================================================== */
		/* list events                                                 */
		/* =========================================================== */

		onSearch: function () {
			this._applyListFilters();
		},

		onRefresh: function () {
			var oViewModel = this.getModel("mpView");
			var sProjectKey = oViewModel.getProperty("/selectedId");
			var sClientKey = oViewModel.getProperty("/selectedClientKey");

			this._loadProjects().then(function () {
				if (sProjectKey) {
					this._showProject({ ProjectKey: sProjectKey, ClientKey: sClientKey });
				}
			}.bind(this));
		},

		onProjectPress: function (oEvent) {
			var oContext = oEvent.getSource().getBindingContext("mp");
			if (oContext) {
				this._showProject(oContext.getObject());
			}
		},

		onProjectSelect: function (oEvent) {
			var oItem = oEvent.getParameter("listItem");
			var oContext = oItem && oItem.getBindingContext("mp");
			if (oContext) {
				this._showProject(oContext.getObject());
			}
		},

		onCloseDetail: function () {
			this._closeDetail();
		},

		_closeDetail: function () {
			var oViewModel = this.getModel("mpView");
			oViewModel.setProperty("/layout", "OneColumn");
			oViewModel.setProperty("/fullScreen", false);
			oViewModel.setProperty("/selectedId", null);
			oViewModel.setProperty("/selectedClientKey", null);
			oViewModel.setProperty("/selectedTab", "info");
			this.getModel("mpDetail").setData({});
			this.getModel("mpTabs").setData(this._emptyTabs());
		},

		onToggleFullScreen: function () {
			var oViewModel = this.getModel("mpView");
			var bFullScreen = !oViewModel.getProperty("/fullScreen");
			oViewModel.setProperty("/fullScreen", bFullScreen);
			oViewModel.setProperty("/layout", bFullScreen ? "MidColumnFullScreen" : "TwoColumnsMidExpanded");
		},

		/* =========================================================== */
		/* list filter                                                 */
		/* =========================================================== */

		onOpenFilter: function () {
			var oViewModel = this.getModel("mpView");
			oViewModel.setProperty("/filterDraft", Object.assign({}, oViewModel.getProperty("/filter")));
			this._openDialog("_pFilterDialog", "bsx.hrx.hrx2026.fragment.ProjectFilterDialog");
		},

		onConfirmFilter: function () {
			var oViewModel = this.getModel("mpView");
			oViewModel.setProperty("/filter", Object.assign({}, oViewModel.getProperty("/filterDraft")));
			this._applyListFilters();
			this._closeDialog("_pFilterDialog");
		},

		onCancelFilter: function () {
			this._closeDialog("_pFilterDialog");
		},

		onClearFilter: function () {
			this.getModel("mpView").setProperty("/filterDraft", { client: "", timeBooking: "A" });
		},

		/* =========================================================== */
		/* project info                                                */
		/* =========================================================== */

		/**
		 * Saves the project header, including the project areas it is broken down into.
		 */
		onSaveProject: function () {
			var oDetail = this.getModel("mpDetail").getData();

			if (!oDetail.ProjectKey) {
				return;
			}
			if (!this._validateRequired([{ id: "projectDesc", value: oDetail.ProjectDesc }])) {
				return;
			}

			this._save(PROJECTS_SERVICE + "?cmd=update", {
				ProjectKey: oDetail.ProjectKey,
				ProjectDesc: oDetail.ProjectDesc,
				ProjectTypeKey: oDetail.ProjectTypeKey || "",
				StartDate: this._isoDate(oDetail.StartDate),
				EndDate: this._isoDate(oDetail.EndDate),
				PriorityKey: oDetail.PriorityKey || "",
				PONumber: oDetail.PONumber || "",
				POValue: String(oDetail.POValue || "0"),
				IsTimeBookingAllowed: oDetail.TimeBooking ? "Y" : "N",
				ProjectManagerID: oDetail.ProjectManagerID || "",
				TotBillableDays: String(oDetail.TotBillableDays || "0"),
				ProjectTask: (oDetail.taskKeys || []).map(function (sTaskKey) {
					return { TaskKey: sTaskKey };
				})
			}, "mpSaved", "mpErrorSave").then(function () {
				return this._loadProjects().then(function () {
					return this._showProject({ ProjectKey: oDetail.ProjectKey, ClientKey: oDetail.ClientKey });
				}.bind(this));
			}.bind(this)).catch(function () { /* reported by _save */ });
		},

		/* =========================================================== */
		/* create project                                              */
		/* =========================================================== */

		onOpenAddProject: function () {
			this.getModel("mpForm").setData({
				ProjectDesc: "",
				ClientKey: "",
				ProjectTypeKey: "",
				PriorityKey: "",
				ProjectManagerID: "",
				PONumber: "",
				POValue: "",
				TotBillableDays: "",
				StartDate: null,
				EndDate: null,
				TimeBooking: true,
				taskKeys: []
			});
			this._openDialog("_pAddProjectDialog", "bsx.hrx.hrx2026.fragment.AddProjectDialog");
		},

		onCancelAddProject: function () {
			this._closeDialog("_pAddProjectDialog");
		},

		onCreateProject: function () {
			var oForm = this.getModel("mpForm").getData();

			if (!this._validateRequired([{ id: "newProjectDesc", value: oForm.ProjectDesc }])) {
				return;
			}
			if (!this._validateSelection([
				{ id: "newProjectClient", value: oForm.ClientKey },
				{ id: "newProjectType", value: oForm.ProjectTypeKey }
			])) {
				return;
			}

			this._save(PROJECTS_SERVICE + "?cmd=new", {
				OrgID: this._sOrgId,
				ProjectKey: "",
				ProjectDesc: oForm.ProjectDesc.trim(),
				ClientKey: oForm.ClientKey,
				ProjectTypeKey: oForm.ProjectTypeKey,
				StartDate: this._isoDate(oForm.StartDate),
				EndDate: this._isoDate(oForm.EndDate),
				PriorityKey: oForm.PriorityKey || "",
				PONumber: oForm.PONumber || "",
				POValue: String(oForm.POValue || "0"),
				CreatedOn: this._today(),
				CreatedBy: "",
				IsTimeBookingAllowed: oForm.TimeBooking ? "Y" : "N",
				ProjectManagerID: oForm.ProjectManagerID || "",
				TotBillableDays: String(oForm.TotBillableDays || "0"),
				ProjectTask: (oForm.taskKeys || []).map(function (sTaskKey) {
					return { TaskKey: sTaskKey };
				})
			}, "mpCreated", "mpErrorCreate").then(function () {
				this._closeDialog("_pAddProjectDialog");
				return this._loadProjects();
			}.bind(this)).catch(function () { /* reported by _save */ });
		},

		/* =========================================================== */
		/* resourcing                                                  */
		/* =========================================================== */

		onAddAssignment: function () {
			this.getModel("mpForm").setData({
				mode: "new",
				AssignmentID: "",
				EmpID: "",
				BillingID: "",
				DayRate: "",
				BillableDays: "",
				StartDate: null,
				IsActive: "Y",
				taskKeys: []
			});
			this._openDialog("_pAssignmentDialog", "bsx.hrx.hrx2026.fragment.AssignmentDialog");
		},

		onEditAssignment: function (oEvent) {
			var oAssignment = oEvent.getSource().getBindingContext("mpTabs").getObject();

			this.getModel("mpForm").setData({
				mode: "edit",
				AssignmentID: oAssignment.ASSIGNMENTID,
				EmpID: oAssignment.EmpID,
				BillingID: oAssignment.BillingID || "",
				DayRate: formatter.clean(oAssignment.DayRate),
				BillableDays: formatter.clean(oAssignment.BillableDays),
				StartDate: formatter.toDate(oAssignment.AssignmentStartDate || oAssignment.StartDate),
				IsActive: oAssignment.IsActive || "Y",
				taskKeys: (oAssignment.TaskAssigned || []).map(function (oTask) {
					return oTask.ProjectTaskKey || oTask.TaskKey;
				})
			});
			this._openDialog("_pAssignmentDialog", "bsx.hrx.hrx2026.fragment.AssignmentDialog");
		},

		onCancelAssignment: function () {
			this._closeDialog("_pAssignmentDialog");
		},

		/**
		 * Picking a billing scheme fills in its day rate, which stays editable.
		 * @param {sap.ui.base.Event} oEvent the selection change event
		 */
		onBillingSchemeChange: function (oEvent) {
			var sBillingId = oEvent.getSource().getSelectedKey();
			var oScheme = (this.getModel("mp").getProperty("/billing") || []).filter(function (oEntry) {
				return oEntry.BillingID === sBillingId;
			})[0];

			if (oScheme) {
				this.getModel("mpForm").setProperty("/DayRate", oScheme.DayRate);
			}
		},

		onSaveAssignment: function () {
			var oForm = this.getModel("mpForm").getData();
			var oDetail = this.getModel("mpDetail").getData();
			var bEdit = oForm.mode === "edit";

			if (!this._validateSelection([
				{ id: "assignmentResource", value: oForm.EmpID },
				{ id: "assignmentBilling", value: oForm.BillingID }
			])) {
				return;
			}
			if (!this._validateRequired([
				{ id: "assignmentDayRate", value: oForm.DayRate },
				{ id: "assignmentDays", value: oForm.BillableDays }
			])) {
				return;
			}

			var fDayRate = parseFloat(oForm.DayRate) || 0;
			var fDays = parseFloat(oForm.BillableDays) || 0;
			var aTasks = (oForm.taskKeys || []).map(function (sTaskKey) {
				return { ProjectTaskKey: sTaskKey };
			});

			var oPayload = bEdit ? {
				AssignmentID: oForm.AssignmentID,
				BillingID: oForm.BillingID,
				DayRate: String(fDayRate),
				BillableDays: String(fDays),
				TotalCharge: String(fDayRate * fDays),
				StartDate: this._isoDate(oForm.StartDate),
				ProjectID: oDetail.ProjectKey,
				EmpID: oForm.EmpID,
				IsActive: oForm.IsActive || "Y",
				TaskAssigned: aTasks
			} : {
				OrgID: this._sOrgId,
				EmpID: oForm.EmpID,
				ProjectID: oDetail.ProjectKey,
				BillingID: oForm.BillingID,
				DayRate: String(fDayRate),
				Currency: "GBP",
				BillableDays: String(fDays),
				TotalCharge: String(fDayRate * fDays),
				StartDate: this._isoDate(oForm.StartDate),
				EndDate: "",
				IsActive: "Y",
				TaskAssigned: aTasks
			};

			// The service expects a PUT for edits and a POST for new assignments.
			this._save(ASSIGNMENTS_SERVICE + (bEdit ? "?cmd=edit" : "?cmd=new"), oPayload,
				bEdit ? "mpAssignmentUpdated" : "mpAssignmentCreated", "mpErrorAssignmentSave",
				bEdit ? "PUT" : "POST").then(function () {
					this._closeDialog("_pAssignmentDialog");
					return this._loadAssignments(oDetail.ProjectKey);
				}.bind(this)).catch(function () { /* reported by _save */ });
		},

		onReleaseAssignment: function (oEvent) {
			var oAssignment = oEvent.getSource().getBindingContext("mpTabs").getObject();
			var sProjectKey = this.getModel("mpView").getProperty("/selectedId");

			MessageBox.confirm(this.getText("mpConfirmRelease", [oAssignment.FullName]), {
				title: this.getText("mpConfirmReleaseTitle"),
				icon: MessageBox.Icon.WARNING,
				emphasizedAction: MessageBox.Action.CANCEL,
				onClose: function (sAction) {
					if (sAction !== MessageBox.Action.OK) {
						return;
					}
					this._save(ASSIGNMENTS_SERVICE + "?cmd=release", {
						orgID: oAssignment.OrgID || this._sOrgId,
						empID: oAssignment.EmpID,
						projectID: oAssignment.ProjectKey || sProjectKey
					}, "mpAssignmentReleased", "mpErrorAssignmentRelease", "PUT").then(function () {
						return this._loadAssignments(sProjectKey);
					}.bind(this)).catch(function () { /* reported by _save */ });
				}.bind(this)
			});
		},

		/* =========================================================== */
		/* client support team                                         */
		/* =========================================================== */

		onAddSupportUser: function () {
			this.getModel("mpForm").setData({
				mode: "new",
				AssignmentID: "",
				UserID: "",
				IsActive: true
			});
			this._openDialog("_pSupportUserDialog", "bsx.hrx.hrx2026.fragment.SupportUserDialog");
		},

		onEditSupportUser: function (oEvent) {
			var oUser = oEvent.getSource().getBindingContext("mpTabs").getObject();

			this.getModel("mpForm").setData({
				mode: "edit",
				AssignmentID: oUser.AssignmentID,
				UserID: oUser.UserID,
				UserName: ((oUser.FName || "") + " " + (oUser.LName || "")).trim(),
				IsActive: oUser.IsActive === "Y"
			});
			this._openDialog("_pSupportUserDialog", "bsx.hrx.hrx2026.fragment.SupportUserDialog");
		},

		onCancelSupportUser: function () {
			this._closeDialog("_pSupportUserDialog");
		},

		onSaveSupportUser: function () {
			var oForm = this.getModel("mpForm").getData();
			var oViewModel = this.getModel("mpView");
			var sClientKey = oViewModel.getProperty("/selectedClientKey");
			var sProjectKey = oViewModel.getProperty("/selectedId");
			var bEdit = oForm.mode === "edit";
			var sToday = this._today();

			if (!bEdit && !this._validateSelection([{ id: "supportUser", value: oForm.UserID }])) {
				return;
			}

			var oPayload = bEdit ? {
				AssignmentID: oForm.AssignmentID,
				UpdatedOn: sToday,
				UpdatedBy: this._sUserEmail,
				IsActive: oForm.IsActive ? "Y" : "N"
			} : {
				OrgID: sClientKey,
				UserID: oForm.UserID,
				ProjectID: sProjectKey,
				AssignedOn: sToday,
				AssignedBy: this._sUserEmail,
				UpdatedOn: "",
				UpdatedBy: "",
				IsActive: oForm.IsActive ? "Y" : "N"
			};

			this._save(SUPPORT_ASSIGNMENTS_SERVICE + (bEdit ? "?cmd=update" : "?cmd=new"), oPayload,
				bEdit ? "mpSupportUserUpdated" : "mpSupportUserCreated", "mpErrorSupportUserSave").then(function () {
					this._closeDialog("_pSupportUserDialog");
					return this._loadSupportTeam(sClientKey, sProjectKey);
				}.bind(this)).catch(function () { /* reported by _save */ });
		},

		/* =========================================================== */
		/* attachments                                                 */
		/* =========================================================== */

		/**
		 * Reads the chosen file and posts it to the attachment service as base64.
		 * @param {sap.ui.base.Event} oEvent the FileUploader change event
		 */
		onAttachmentChange: function (oEvent) {
			var aFiles = oEvent.getParameter("files");
			var oFile = aFiles && aFiles[0];
			var oUploader = oEvent.getSource();
			if (!oFile) {
				return;
			}

			var sProjectKey = this.getModel("mpView").getProperty("/selectedId");
			var oReader = new FileReader();

			oReader.onload = function (oLoadEvent) {
				// The service stores the raw base64 payload without the data: prefix.
				var sBase64 = String(oLoadEvent.target.result).split(",")[1] || "";

				this._save(ATTACHMENTS_SERVICE + "?cmd=new", {
					orgID: this._sOrgId,
					projectID: sProjectKey,
					fileName: oFile.name,
					fileType: oFile.type,
					attachment: sBase64,
					empID: "",
					uploadedOn: this._today()
				}, "mpAttachmentUploaded", "mpErrorAttachmentUpload").then(function () {
					oUploader.setValue("");
					return this._loadAttachments(sProjectKey);
				}.bind(this)).catch(function () {
					oUploader.setValue("");
				});
			}.bind(this);

			oReader.readAsDataURL(oFile);
		},

		onAttachmentTypeMismatch: function (oEvent) {
			MessageToast.show(this.getText("mpErrorFileType", [oEvent.getParameter("fileType")]));
		},

		/**
		 * Streams a stored attachment back to the browser as a download.
		 * @param {sap.ui.base.Event} oEvent the button press event
		 */
		onDownloadAttachment: function (oEvent) {
			var oAttachment = oEvent.getSource().getBindingContext("mpTabs").getObject();
			var sContent = oAttachment.Attachment || "";

			if (!sContent) {
				MessageToast.show(this.getText("mpErrorAttachmentEmpty"));
				return;
			}

			var sHref = sContent.indexOf("data:") === 0
				? sContent
				: "data:" + (oAttachment.FileType || "application/octet-stream") + ";base64," + sContent;

			var oLink = document.createElement("a");
			oLink.href = sHref;
			oLink.download = oAttachment.FileName || "attachment";
			document.body.appendChild(oLink);
			oLink.click();
			document.body.removeChild(oLink);
		},

		onDeleteAttachment: function (oEvent) {
			var oAttachment = oEvent.getSource().getBindingContext("mpTabs").getObject();
			var sProjectKey = this.getModel("mpView").getProperty("/selectedId");

			MessageBox.confirm(this.getText("mpConfirmDeleteAttachment", [oAttachment.FileName]), {
				title: this.getText("mpConfirmDeleteAttachmentTitle"),
				icon: MessageBox.Icon.WARNING,
				emphasizedAction: MessageBox.Action.CANCEL,
				onClose: function (sAction) {
					if (sAction !== MessageBox.Action.OK) {
						return;
					}
					this._save(ATTACHMENTS_SERVICE + "?cmd=delete", {
						attachmentID: oAttachment.AttachmentID,
						orgID: this._sOrgId,
						projectID: sProjectKey
					}, "mpAttachmentDeleted", "mpErrorAttachmentDelete").then(function () {
						return this._loadAttachments(sProjectKey);
					}.bind(this)).catch(function () { /* reported by _save */ });
				}.bind(this)
			});
		},

		/* =========================================================== */
		/* helpers                                                     */
		/* =========================================================== */

		getModel: function (sName) {
			return this.getView().getModel(sName);
		},

		setModel: function (oModel, sName) {
			this.getView().setModel(oModel, sName);
			return this;
		},

		getResourceBundle: function () {
			return this.getOwnerComponent().getModel("i18n").getResourceBundle();
		},

		getText: function (sKey, aArgs) {
			return this.getResourceBundle().getText(sKey, aArgs);
		},

		_save: function (sUrl, oPayload, sSuccessKey, sErrorKey, sMethod) {
			var oViewModel = this.getModel("mpView");
			oViewModel.setProperty("/saving", true);

			return this._request(sUrl, {
				method: sMethod || "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(oPayload)
			}).then(function (oResult) {
				oViewModel.setProperty("/saving", false);
				MessageToast.show(oResult.msg || this.getText(sSuccessKey));
				return oResult;
			}.bind(this)).catch(function (oError) {
				oViewModel.setProperty("/saving", false);
				this._showError(sErrorKey, oError);
				throw oError;
			}.bind(this));
		},

		_validateRequired: function (aFields) {
			var bValid = true;

			aFields.forEach(function (oField) {
				var oControl = this.byId(oField.id);
				var bFilled = !!String(oField.value === undefined || oField.value === null ? "" : oField.value).trim();
				oControl.setValueState(bFilled ? "None" : "Error");
				oControl.setValueStateText(this.getText("mpMandatory"));
				bValid = bValid && bFilled;
			}, this);

			return bValid;
		},

		_validateSelection: function (aFields) {
			var bValid = true;

			aFields.forEach(function (oField) {
				var oControl = this.byId(oField.id);
				var bFilled = !!oField.value;
				oControl.setValueState(bFilled ? "None" : "Error");
				oControl.setValueStateText(this.getText("mpMandatory"));
				bValid = bValid && bFilled;
			}, this);

			return bValid;
		},

		_read: function (sPath, mParameters) {
			var oModel = this.getOwnerComponent().getModel();

			return new Promise(function (resolve, reject) {
				oModel.read(sPath, Object.assign({}, mParameters, {
					success: resolve,
					error: reject
				}));
			});
		},

		_getJson: function (sUrl) {
			return this._request(sUrl, { method: "GET" });
		},

		_request: function (sUrl, oInit) {
			return fetch(sUrl, oInit).then(function (oResponse) {
				return oResponse.text().then(function (sBody) {
					var oJson = null;
					try {
						oJson = sBody ? JSON.parse(sBody) : null;
					} catch (oParseError) {
						oJson = null;
					}

					if (!oResponse.ok || !oJson || oJson.msgType !== "S") {
						throw new Error((oJson && (oJson.msg || oJson.message)) || sBody || oResponse.statusText);
					}

					return oJson;
				});
			});
		},

		_openDialog: function (sCacheKey, sFragmentName) {
			if (!this[sCacheKey]) {
				this[sCacheKey] = Fragment.load({
					id: this.getView().getId(),
					name: sFragmentName,
					controller: this
				}).then(function (oDialog) {
					this.getView().addDependent(oDialog);
					return oDialog;
				}.bind(this));
			}

			return this[sCacheKey].then(function (oDialog) {
				oDialog.open();
				return oDialog;
			});
		},

		_closeDialog: function (sCacheKey) {
			if (this[sCacheKey]) {
				this[sCacheKey].then(function (oDialog) {
					oDialog.close();
				});
			}
		},

		_strip: function (oData) {
			return (oData.results || []).map(function (oRow) {
				var oCopy = Object.assign({}, oRow);
				delete oCopy.__metadata;
				return oCopy;
			});
		},

		_isoDate: function (vDate) {
			var oDate = formatter.toDate(vDate);
			if (!oDate) {
				return "";
			}
			var sMonth = String(oDate.getMonth() + 1).padStart(2, "0");
			var sDay = String(oDate.getDate()).padStart(2, "0");
			return oDate.getFullYear() + "-" + sMonth + "-" + sDay;
		},

		_today: function () {
			return this._isoDate(new Date());
		},

		_defaultFilter: function () {
			return { client: "", timeBooking: "Y" };
		},

		_emptyTabs: function () {
			return { assignments: [], supportTeam: [], clientUsers: [], attachments: [] };
		},

		_resolveOrgId: function () {
			this._sUserEmail = CurrentUser.email(this.getOwnerComponent());
			return CurrentUser.orgId(this.getOwnerComponent());
		},

		_errorText: function (oError) {
			if (!oError) {
				return "";
			}
			if (oError.message) {
				return oError.message;
			}
			if (oError.responseText) {
				try {
					var oBody = JSON.parse(oError.responseText);
					return oBody.msg || (oBody.error && oBody.error.message && oBody.error.message.value) || oError.responseText;
				} catch (oParseError) {
					return oError.responseText;
				}
			}
			return String(oError);
		},

		_showError: function (sTextKey, oError) {
			MessageBox.error(this.getText(sTextKey), {
				details: this._errorText(oError)
			});
		}
	});
});
