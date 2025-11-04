"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailStatus = void 0;
var EmailStatus;
(function (EmailStatus) {
    EmailStatus["PENDING"] = "PENDING";
    EmailStatus["QUEUED"] = "QUEUED";
    EmailStatus["PROCESSING"] = "PROCESSING";
    EmailStatus["SENT"] = "SENT";
    EmailStatus["FAILED"] = "FAILED";
    EmailStatus["OPENED"] = "OPENED";
    EmailStatus["REPLIED"] = "REPLIED";
})(EmailStatus || (exports.EmailStatus = EmailStatus = {}));
