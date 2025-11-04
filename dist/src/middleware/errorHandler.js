"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = exports.AppError = void 0;
class AppError extends Error {
    constructor(message, statusCode, details) {
        super(message);
        this.details = details;
        this.statusCode = statusCode;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}
exports.AppError = AppError;
const errorHandler = (err, _req, res, _next) => {
    if (err instanceof AppError) {
        res.status(err.statusCode).json({
            error: err.message,
            ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
        });
        return;
    }
    console.error("Unexpected error:", err);
    res.status(500).json({
        error: "Internal server error",
        ...(process.env.NODE_ENV === "development" && {
            message: err.message,
            stack: err.stack,
        }),
    });
};
exports.errorHandler = errorHandler;
