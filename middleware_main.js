const jwt = require('jsonwebtoken');  // Make sure you have the jsonwebtoken module installed

// Function to verify the JWT token
function verifyJWTToken(authorizationHeader) {
    if (!authorizationHeader) {
        throw new Error('Authorization header is missing');
    }

    // Extract the token from the Authorization header (Bearer <token>)
    const token = authorizationHeader.split(' ')[1];  // Assuming format: "Bearer <token>"

    if (!token) {
        throw new Error('Token is missing');
    }

    try {
        // Replace 'your-secret-key' with your actual secret key, or use a public key if you're verifying an RS256 token
        const decoded = jwt.verify(token, 'your-secret-key');  // You may need to replace this with your actual secret key
        if (!decoded.customer_id) return "Invalid or expired JWT token."
        // Return the decoded token information
        return decoded;  // This will contain the userId and other details from the token
    } catch (error) {
        throw new Error('Invalid token or token verification failed: ' + error.message);
    }
}

module.exports = {
    verifyJWTToken,
};
