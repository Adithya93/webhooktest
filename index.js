var express = require('express');
var app = express();

app.listen(3000);

app.get("/", function(req, res) {
	res.send("Booya!");
});

app.post("/webhook", function(req, res) {
	console.log("NERD ALERT! Post received to webhook!");
	res.sendStatus(200);
});