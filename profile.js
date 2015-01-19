var ac = require('./autoclick-opencv');
autoclick = new ac.Autoclick();
autoclick.enable();
setTimeout(function() {
	autoclick.disable();
}, 15000);
