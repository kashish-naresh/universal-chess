class AppError extends Error {
  constructor(message, code = 'REQUEST_FAILED', status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}
module.exports = { AppError };
