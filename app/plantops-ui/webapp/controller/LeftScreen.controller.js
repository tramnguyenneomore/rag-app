sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/upload/UploadSetwithTable",
	"sap/m/upload/UploadSetwithTableItem",
    "sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
    "sap/m/MessageToast",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox"
], function(Controller, UploadSetwithTable, UploadSetwithTableItem,
     Filter, FilterOperator, MessageToast, JSONModel, MessageBox) {
    'use strict';
    
    return Controller.extend("plantopsassistant.controller.LeftScreen", {

        onInit: function(){            
            // Set User Info Model
            this.getUserInfo();

            this.oOwnerComponent = this.getOwnerComponent();
			this.oRouter = this.oOwnerComponent.getRouter();
			this.oRouter.getRoute("home").attachPatternMatched(this.onRouteMatched, this);
            this.oRouter.getRoute("conversation").attachPatternMatched(this.onRouteMatched, this);
        },

        onRouteMatched(oEvent){
            
            this.getView().byId("leftScreenChatList").getBinding("items").refresh();
        },

        onConversationPress: function(oEvent){
    
            const listItem = oEvent.getParameter("listItem");
            const conversationID = listItem.getBindingContext().getProperty("cID");
            const oRouter = this.getOwnerComponent().getRouter();
            oRouter.navTo("conversation", {
                conversationID: conversationID
            });
        },

        onHandleConversationDelete: function(oEvent){

            const listItem = oEvent.getParameter("listItem");
            const conversationID = listItem.getBindingContext().getProperty("cID");
            const conversationTitle = listItem.getBindingContext().getProperty("title").toString();
            
            const oRouter = this.getOwnerComponent().getRouter();
            const curRouteHash = oRouter.getHashChanger().getHash();
            const curRouteName = oRouter.getRouteInfoByHash(curRouteHash);

            MessageBox.warning(
                `This will delete ${conversationTitle}`, 
                {
                    icon: MessageBox.Icon.WARNING,
					actions: ["Remove", MessageBox.Action.CANCEL],
					emphasizedAction: "Remove",
					styleClass: "sapMUSTRemovePopoverContainer",
					initialFocus: MessageBox.Action.CANCEL,
                    onClose: (sAction) => {
                        if (sAction !== "Remove") {
							return;
						}
                        this.requestConversationDelete(conversationID)
                        .then((result)=> {
                            MessageToast.show(`Conversation successfully deleted.`);
                            if(curRouteName.name !== "home"){
                                this.oRouter.navTo("home");
                            }
                            else{
                                this.getView().byId("leftScreenChatList").getBinding("items").refresh();
                            }
                        })
                        .catch((error) => {
                            console.log(error);
                            MessageToast.show(`Conversation deletion failed.`);
                        });
                    }
                }
            );
        },

        requestConversationDelete: function (conversationID) {
            const settings = {
                url: `/odata/v4/chat/Conversation(${conversationID})`,
                method: "DELETE",
                headers: {
                    "Content-type": "application/json",
                    "Authorization": "Basic " + btoa("dummy.user@com:initial")
                }
            }
            return new Promise((resolve, reject) => {
                $.ajax(settings)
                    .done((results, textStatus, request) => {
                        resolve(results);
                    })
                    .fail((err) => {
                        reject(err);
                    })
            });				
        },

        onCreateNewChat: function(oEvent){
            const oRouter = this.getOwnerComponent().getRouter();
            oRouter.navTo("home");
        },

        onManageFileBtnSelect: function(){
            if (!this.fileManagementFragment) {
                this.fileManagementFragment = this.loadFragment({
                    name: "plantopsassistant.view.FileManagement"
                });
            }
            this.fileManagementFragment.then((oFragment) => oFragment.open());
        },

        onCloseManageFileFragment: function(){
            
            this.byId("fileManagementFragment").close();
        },

        /** Event Handlers for File Uploading Fragment **/
        onBeforeUploadStart: function (oEvent) {
            console.log(oEvent);
            oEvent.preventDefault();
            
            const item = oEvent.getParameter("item");
            const maxSize = 10 * 1024 * 1024; // 10MB in bytes

            
            if (item.getFileObject().size > maxSize) {
                MessageToast.show("File size exceeds the maximum limit of 10MB");
                this.byId("uploadSetWithTable").removeItem(item);
                return;
            }
            // Disable upload while file is uploading
            this.setUploadEnabled(false);

            
            // Show busy indicator during upload
            this.byId("fileManagementFragment").setBusy(true);
            
            this.createEntity(item)
                .then((id) => {
                    // Upload is already disabled, proceed with content upload
                    return this.uploadContent(item, id, oEvent);
                })
                .catch((err) => {
                    console.log("Upload process failed:", err);
                    
                    // Clear uploading flag, re-enable upload, and hide busy indicator
                    this.setUploadEnabled(true);
                    this.byId("fileManagementFragment").setBusy(false);
                    
                    // Determine appropriate error message
                    let errorMessage = "Failed to upload file";
                    if (err.status === 413) {
                        errorMessage = "File too large for upload";
                    } else if (err.status === 0) {
                        errorMessage = "Network error - please check your connection";
                    } else if (err.status >= 500) {
                        errorMessage = "Server error - please try again later";
                    }
                    
                    MessageToast.show(errorMessage);
                    // Remove the item from UI since upload failed
                    this.byId("uploadSetWithTable").removeItem(item);
                });
        },

        onUploadCompleted: function (oEvent) {
            // Get more details about the upload
            const oItem = oEvent.getParameter("item");
            
            var oUploadSetWithTable = this.byId("uploadSetWithTable");
            
            // Remove incomplete items if method exists
            if (oUploadSetWithTable.removeAllIncompleteItems) {
                oUploadSetWithTable.removeAllIncompleteItems();
            }
            
            
            setTimeout(() => {
                oUploadSetWithTable.getBinding("items").refresh();
            }, 1000);
        },

        createEntity: function (item) {
            const data = {
                ID: this.generateUUID(),
                mediaType: item.getMediaType(),
                fileName: item.getFileName(),
                size: item.getFileObject().size.toString(),
            };
            const settings = {
                url: "/odata/v4/embedding-storage/Files",
                method: "POST",
                headers: {
                    "Content-type": "application/json"
                },
                data: JSON.stringify(data)
            }
            return new Promise((resolve, reject) => {
                $.ajax(settings)
                    .done((results, textStatus, request) => {
                        resolve(results.ID);
                    })
                    .fail((err) => {
                        reject(err);
                    })
            });				
        },

        generateUUID: function() {
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                var r = Math.random() * 16 | 0,
                    v = c == 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        },

        uploadContent: function (item, id, oEvent) {
            var file = item.getFileObject(); // Blob from UploadSet
            var url = `/odata/v4/embedding-storage/Files(${id})/content`;
        
            return new Promise((resolve, reject) => {
                $.ajax({
                    url: url,
                    method: "PUT",
                    processData: false, 
                    contentType: file.type,
                    data: file, 
                    success: (results) => { 
                        // Note: Keep fragment busy during embedding generation
                        // Upload will be re-enabled after embedding generation completes
                        resolve(results);
                        this.onUploadCompleted(oEvent);
                        this.generateVector(id);
                    },
                    error: (err) => {
                        this.setUploadEnabled(true);
                        console.log("Upload content failed, cleaning up entity:", err);
                        // Clean up the orphaned entity since content upload failed
                        this.requestFileDelete(id)
                            .then(() => {
                                console.log("Orphaned entity cleaned up successfully");
                            })
                            .catch((deleteErr) => {
                                console.error("Failed to clean up orphaned entity:", deleteErr);
                            });
                        reject(err);
                    }
                });
            });
        },    
        
        generateVector: function(pdfFileID){
            this.byId("fileManagementFragment").setBusy(true);
            
            this.requestEmbeddingGeneration(pdfFileID)
                .then((oReturn) => {
                    this.byId("fileManagementFragment").setBusy(false);
                    // Re-enable upload after embedding generation completes
                    this.setUploadEnabled(true);
                    MessageToast.show("Embeddings generation completed successfully.");
                })
                .catch((error) => {
                    console.log(error);
                    this.byId("fileManagementFragment").setBusy(false);
                    // Re-enable upload even if embedding generation fails
                    this.setUploadEnabled(true);
                    MessageToast.show("Embeddings generation failed, please try again.");
                });
        },

        /** Event Handlers for File Management Fragment **/

        onSelectionChange: function(oEvent){

            const oTable = oEvent.getSource();
            const aSelectedItems = oTable.getSelectedItems();
			const oDownloadBtn = this.byId("downloadSelectedButton");
            const oDeleteBtn = this.byId("deleteSelectedButton");

            if (aSelectedItems.length > 0) {
				oDownloadBtn.setEnabled(true);
                oDeleteBtn.setEnabled(true);
			} else {
				oDownloadBtn.setEnabled(false);
                oDeleteBtn.setEnabled(false);
			}
        },

        getIconSrc: function(mediaType, thumbnailUrl) {
			return UploadSetwithTable.getIconForFileType(mediaType, thumbnailUrl);
		},

        getFileSizeWithUnits: function(iFileSize) {
			return UploadSetwithTable.getFileSizeWithUnits(iFileSize);
		},

        onFileNameSearch: function(oEvent){

            const aFilters = [];
            const sQuery = oEvent.getSource().getValue();
            if (sQuery && sQuery.length > 0) {
				const filter = new Filter("fileName", FilterOperator.Contains, sQuery);
				aFilters.push(filter);
			}

            // Update list binding
			const oUploadSet = this.byId("uploadSetWithTable");
            const oBinding = oUploadSet.getBinding("items");
            oBinding.filter(aFilters, "Application");
        },

        onDownloadFiles: function(oEvent){

            const oUploadSetTable = this.byId("uploadSetWithTable");
			const oItem = oUploadSetTable.getSelectedItem();
            const oAggregations = oItem.mAggregations;
            const fileID = oAggregations.cells[1].getProperty("text");
            const fileName = oItem.getProperty("fileName");

            this.requestFileDownload(fileID)
                .then((blob) => {
                    var url = window.URL.createObjectURL(blob);
                    // Download
					var link = document.createElement('a');
					link.href = url;
					link.setAttribute('download', fileName);
					document.body.appendChild(link);
					link.click();
					document.body.removeChild(link);			
                })
                .catch((error) => {
                    console.log(error);
                });

        },

        requestFileDownload: function(fileID){

            const settings = {
                url: `/odata/v4/embedding-storage/Files(${fileID})/content`,
                method: "GET",
                xhrFields:{
                    responseType: "blob"
                }
            };

            return new Promise((resolve, reject) => {
                $.ajax(settings)
                .done((result, textStatus, request) => {
                    resolve(result);
                })
                .fail((err) => {
                    reject(err);
                })
            });
        },

        requestEmbeddingGeneration: function(pdfFileID){

            const payload = JSON.stringify({
                uuid: pdfFileID.toString(),
            });

            return new Promise((resolve, reject) => {

                $.ajax({
                    url: "/odata/v4/embedding-storage/storeEmbeddings",
                    type: "POST",
                    contentType: 'application/json',
                    async: true,
                    data: payload,
                    success: function (body, status, response) {
                        console.log("Success: " + response);
                        if (response.status === 200 || response.status === 201) {
                            resolve(response.responseJSON);
                        } else {
                            reject(response.responseJSON)
                        }
                    },
                    error: function (response, status) {
                        console.log("Fail: " + response);
                        if (response) {
                            if (response.responseJSON) {
                                const msg = response.responseJSON.message || response.responseJSON.status_msg;
                                reject(msg);
                            } else {
                                reject(response.responseText);
                            }
                        } else {
                            reject(status);
                        }
                    }
                });
            });
        },

        onBeforeOpenContextMenu: function(oEvent){
            this.byId("uploadSetWithTable").getBinding("items").refresh();
        },

        beforeFileManagementDialogOpen: function(oEvent){
            this.byId("uploadSetWithTable").getBinding("items").refresh();
        },

        onDeleteFiles: function(oEvent){

            this.byId("fileManagementFragment").setBusy(true);
            const oUploadSetTable = this.byId("uploadSetWithTable");
			const oItem = oUploadSetTable.getSelectedItem();
            const oAggregations = oItem.mAggregations;
            const fileID = oAggregations.cells[1].getProperty("text");
            const fileName = oItem.getProperty("fileName");

            this.requestFileDelete(fileID)
                .then((result) => {

                    this.byId("fileManagementFragment").setBusy(false);
                    this.byId("uploadSetWithTable").getBinding("items").refresh();

                    const oDownloadBtn = this.byId("downloadSelectedButton");
                    const oDeleteBtn = this.byId("deleteSelectedButton");
                    oDownloadBtn.setEnabled(false);
                    oDeleteBtn.setEnabled(false);

                    MessageToast.show(`File ${fileName} with ID ${fileID} successfully deleted`);			
                })
                .catch((error) => {

                    console.log(error.message);
                    this.byId("fileManagementFragment").setBusy(false);	
                    MessageToast.show(`File ${fileName} with ID ${fileID} deletion failed`);
                });
        },

        requestFileDelete: function(fileID){

            const settings = {
                url: `/odata/v4/embedding-storage/Files(${fileID})`,
                method: "DELETE",
            };

            return new Promise((resolve, reject) => {
                $.ajax(settings)
                .done((result, textStatus, request) => {
                    resolve(result);
                })
                .fail((err) => {
                    reject(err);
                })
            });
        },

        onDeleteEmbedding: function(oEvent){

            this.byId("fileManagementFragment").setBusy(true);
            this.requestEmbeddingDelete()
            .then((result) => {
                this.byId("fileManagementFragment").setBusy(false);
                MessageToast.show(`All embeddings successfully deleted.`);			
            })
            .catch((error) => {

                console.log(error.message);
                this.byId("fileManagementFragment").setBusy(false);	
                MessageToast.show(`Embeddings deletion failed.`);
            });
        },

        requestEmbeddingDelete: function(){

            const settings = {
                url: "/odata/v4/embedding-storage/deleteEmbeddings()",
                method: "GET",
            };

            return new Promise((resolve, reject) => {
                $.ajax(settings)
                .done((result, textStatus, request) => {
                    resolve(result);
                })
                .fail((err) => {
                    reject(err);
                })
            });
        },

        /** Event Handlers for Approuter **/

        getUserInfo: function(){         
            const url = this.getBaseURL() + "/user-api/currentUser";
            var oModel = new JSONModel();
            var mock = {
                firstname: "Dummy",
                lastname: "User",
                email: "dummy.user@com",
                name: "dummy.user@com",
                displayName: "Dummy User (dummy.user@com)"
            }; 
            oModel.loadData(url);
            oModel.dataLoaded()
            .then(()=>{
                // Check if data has been loaded
                // For local testing, set mock data
                console.log(oModel.getData());
                if (!oModel.getData().email) {
                    oModel.setData(mock);
                }
                this.getView().setModel(oModel, "userInfo");
            })
            .catch(()=>{               
                oModel.setData(mock);
                this.getView().setModel(oModel, "userInfo");
            });
        },

        getBaseURL: function () {

            var appId = this.getOwnerComponent().getManifestEntry("/sap.app/id");
            var appPath = appId.replaceAll(".", "/");
            var appModulePath = jQuery.sap.getModulePath(appPath);

            return appModulePath;
        },

        /** Helper Methods **/
        
        setUploadEnabled: function(enabled) {
            var oUploadSetWithTable = this.byId("uploadSetWithTable");
            if (oUploadSetWithTable) {
                oUploadSetWithTable.setUploadEnabled(enabled);
            }
        }
    });
});