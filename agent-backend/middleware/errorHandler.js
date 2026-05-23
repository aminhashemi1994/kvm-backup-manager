/**
 * Global error handler middleware
 */
const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);

  // Check if response has already been sent
  if (res.headersSent) {
    console.error('Headers already sent, cannot send error response');
    return next(err);
  }

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    },
  });
};

module.exports = errorHandler;
