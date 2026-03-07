// Centralized error handler for unexpected errors
export default function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || (err.type === "entity.too.large" ? 413 : 500);
  if (status >= 500) {
    console.error("Unhandled error:", err);
  } else {
    console.warn("Handled error:", status, err?.message || err);
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({ message: "Payload too large" });
  }
  if (String(err?.message || "").includes("CORS")) {
    return res.status(403).json({ message: "Origin is not allowed" });
  }
  return res.status(status).json({
    message: status >= 500 ? "Internal Server Error" : (err.message || "Request failed"),
  });
}
