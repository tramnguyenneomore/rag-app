sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/routing/History",
    "sap/m/MessageToast"
], function (Controller, History, MessageToast) {
    "use strict";

    return Controller.extend("hrapprovalui.controller.Main", {
        onInit: function () {
            // Initialize your controller here
        },

        onNavBack: function () {
            var oHistory = History.getInstance();
            var sPreviousHash = oHistory.getPreviousHash();

            if (sPreviousHash !== undefined) {
                window.history.go(-1);
            } else {
                var oRouter = this.getOwnerComponent().getRouter();
                oRouter.navTo("Main", {}, true);
            }
        },

        onUploadPress: function() {
            var oUploadSet = this.byId("uploadSet");
            if (!oUploadSet.getItems().length) {
                MessageToast.show("Please select a file first");
                return;
            }
            
            oUploadSet.upload();
            MessageToast.show("Upload started");
        }
    });
}); 