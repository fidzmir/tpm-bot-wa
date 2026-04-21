const express = require('express');
const app = express();
app.use(express.json());
app.post('/test', (req, res) => {
    console.log("📩 DATA MASUK!");
    res.send("OK");
});
app.listen(3000, () => console.log("Server Test Jalan di 3000"));