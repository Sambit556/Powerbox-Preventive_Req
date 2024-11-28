const jwt = require("jsonwebtoken"); // Install using npm install jsonwebtoken
// Middleware to verify JWT
export function verifyJWT(headers) {
    const token = headers.Authorization || headers.authorization;
    if (!token) {
        throw new Error("JWT token is missing");
    }

    try {
        const decoded = jwt.verify(token.replace("Bearer ", ""), JWT_SECRET);
        return decoded; // Decoded payload, typically contains customerName and cust_id
    } catch (err) {
        throw new Error("Invalid or expired JWT token");
    }
}