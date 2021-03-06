var serial = require('serialport');
var fs = require('fs');
var stream = require('binary-stream');
var sets = require('simplesets');

var _ = require("underscore");

var commons = require('./commons');
var parsers = require('./parsing');
var fbCom = require('./firebaseCom');
var CronJob = require('cron').CronJob;

function ChillhubDevice(ttyPath) {
	var self = this;
	
	this.deviceType = '';
	this.subscriptions = new sets.Set([]);
	this.buf = [];
	this.cronJobs = {};
	self.schema = {}
	self.objectId = '';
	
	this.uid = ttyPath;
	this.tty = new serial.SerialPort('/dev/'+ttyPath, { 
		baudrate: 115200, 
		disconnectedCallback: function(err) {
			if (err) {
				console.log('error in disconnectedCallback');
				console.log(err);
			}
		}
	});
	
	this.tty.open(function(err) {
		if (err) {
			console.log('error opening serial port');
			console.log(err);
			return;
		}
		
		self.tty.on('data', function(data) {
			// network byte order is big endian... let's go with that
			self.buf = self.buf.concat((new stream.Reader(data, stream.BIG_ENDIAN)).readBytes(data.length));
			while(self.buf.length > self.buf[0]) {
				msg = self.buf.slice(1,self.buf[0]+1);
				self.buf = self.buf.slice(self.buf[0]+1,self.buf.length);
				if (msg.length > 0)
					routeIncomingMessage(msg);
			}
		});
		self.tty.on('error', function(err) {
			console.log('serial error:');
			console.log(err);
		});
		self.tty.on('disconnect', function(err) {
			console.log('error disconnecting?');
			console.log(err);
		});
	
		self.send = function(data) {
			console.log("SEND DATA",data)
			// parse data into the format that usb devices expect and transmit it
			var dataBytes = parsers.parseJsonToStream(data);
			var writer = new stream.Writer(dataBytes.length+1, stream.BIG_ENDIAN);
			
			writer.writeUInt8(dataBytes.length);
			writer.writeBytes(dataBytes);
			console.log("WRITER in send",writer.toArray());
			self.tty.write(writer.toArray(), function(err) {
				if (err) {
					console.log('error writing to serial');
					console.log(err);
				}
			});
		};
	});
	
	function cronCallback(id) {
		return function() {
			var msgContent = commons.encodeTime(id);
			
			self.send({
				type: 0x05,
				content: msgContent
			});
		};
	}
	
	function routeIncomingMessage(data) {
		// parse into whatever form and then send it along
		var jsonData = parsers.parseStreamToJson(data);
		
		switch (jsonData.type) {
			case 0x00:
				self.deviceType = jsonData.content;
				console.log('REGISTERed device "'+self.deviceType+'"!');

				// Load Schema for this deviceType
				fbCom.loadSchema(self.deviceType,function(data){
					console.log("schema DATA",data)
					self.schema = data

					//Attach listener to each field in schema
					//FIXME get objectID dynamically... call the fbCom function to populate the refrigerator container with objects and get the objectId from that
					self.objectId = "-J_M7uoN2pjqP8I7LD3T"
					_.each(_.keys(self.schema),function(field){
						// var field = f
						fbCom.addListener("objects",objectId,field,function(value){
							// send new value to Arduino
							self.send({
								type: self.schema[field].messageType,
								content: {
									numericType: self.schema[field].contentType,
									numericValue: value //0-100
								}
							});
						});
					});
				});

				break;
			case 0x01: // subscribe to data stream
				console.log(self.deviceType + ' SUBSCRIBEs to ' + jsonData.content + '!');
				self.subscriptions.add(jsonData.content);
				break;
			case 0x02: // unsubscribe to data stream
				console.log(self.deviceType + ' UNSUBSCRIBEs to ' + jsonData.content + '!');
				self.subscriptions.remove(jsonData.content);
				break;
			case 0x03: // set alarm
				var cronId = jsonData.content.charCodeAt(0);
				var cronString = jsonData.content.substring(1);
				console.log(self.deviceType + ' ALARM_SETS ' + cronString + '(' + cronId + ') !');
				self.cronJobs[cronId] = new CronJob(cronString, cronCallback(cronId));
				self.cronJobs[cronId].start();
				break;
			case 0x04: // unset alarm
				console.log(self.deviceType + ' ALARM_UNSETS (' + jsonData.content + ') !');
				if (self.cronJobs[jsonData.content]) {
					self.cronJobs[jsonData.content].stop();
					delete self.cronJobs[jsonData.content];
				}
				break;
			case 0x06: // get time
				self.send({
					type: 0x07,
					content: commons.encodeTime()
				});
				break;
			default:
				jsonData.device = self.deviceType;
				console.log("TYPE received",jsonData.type)
				console.log("CONTENT received",jsonData.content)

				if (schema) {
					//Find in schema which field has this messageType
					var type = _.findWhere(self.schema,{messageType: jsonData.type}).fieldName
					
					//Update the corresponding value in Firebase
					fbCom.updateObjectFieldFirebase(self.objectId,type,jsonData.content)
				}
		}	
	}	

	self.cleanup = function() {
		// FIXME tell firebase that this item no longer exists
		for (var j in self.cronJobs)
			self.cronJobs[j].stop();
	};
}

var devices = {};

exports.init = function() {
	var filePattern = /^ttyACM[0-9]{1,2}$/;
	
	fs.readdir('/dev/', function(err, files) {
		files = files.filter(function(file) {
			return filePattern.test(file);
		});
		
		files.forEach(function(filename) {
			console.log('registering new USB device ' + filename);
			devices[filename] = new ChillhubDevice(filename);
		});
	});
	
	// watch for new devices
	fs.watch('/dev/', function(event, filename) {
		if (!filePattern.test(filename))
			return;
		
		fs.exists('/dev/'+filename, function (exists) {
			if (devices[filename] && !exists) {
				console.log('unregistering USB device ' + filename);
				devices[filename].cleanup();
				delete devices[filename];
				// FIXME something that we're doing when a device disconnects causes chillhub to crash and needs to be fixed
			}
			else if (!devices[filename] && exists) {
				console.log('registering new USB device ' + filename);
				devices[filename] = new ChillhubDevice(filename);
			}
		});
	});
};

exports.subscriberBroadcast = function(type, data) {
	var SUBSCRIPTION_MESSAGES = {
		filterAlert: { id: 0x10, format: 'U8' },
		waterFilterCalendarTimer: { id: 0x11, format: 'U16' },
		waterFilterCalendarPercentUsed: { id: 0x12, format: 'U8' },
		waterFilterHoursRemaining: { id: 0x13, format: 'U16' },
		waterUsageTimer: { id: 0x14, format: 'U32' },
		waterFilterUsageTimePercentUsed: { id: 0x15, format: 'U8' },
		waterFilterOuncesRemaining: { id: 0x16, format: 'U32' },
		commandFeatures: { id: 0x17, format: 'U8' },
		temperatureAlert: { id: 0x18, format: 'U8' },
		freshFoodTemperatureDisplay: { id: 0x19, format: 'I8' },
		freezerTemperatureDisplay: { id: 0x1A, format: 'I8' },
		freshFoodTemperatureSetpoint: { id: 0x1B, format: 'I8' },
		freezerTemperatureSetpoint: { id: 0x1C, format: 'I8' },
		doorAlarmAlert: { id: 0x1D, format: 'U8' },
		iceMakerBucketStatus: { id: 0x1E, format: 'U8' },
		odorFilterCalendarTimer: { id: 0x1F, format: 'U16' },
		odorFilterPercentUsed: { id: 0x20, format: 'U8' },
		odorFilterHoursRemaining: { id: 0x21, format: 'U8' },
		doorState: { id: 0x22, format: 'U8' },
		dcSwitchState: { id: 0x23, format: 'U8' },
		acInputState: { id: 0x24, format: 'U8' },
		iceMakerMoldThermistorTemperature: { id: 0x25, format: 'I16' },
		iceCabinetThermistorTemperature: { id: 0x26, format: 'I16' },
		hotWaterThermistor1Temperature: { id: 0x27, format: 'U16' },
		hotWaterThermistor2Temperature: { id: 0x28, format: 'U16' },
		dctSwitchState: { id: 0x29, format: 'U8' },
		relayStatus: { id: 0x2A, format: 'U8' },
		ductDoorStatus: { id: 0x2B, format: 'U8' },
		iceMakerStateSelection: { id: 0x2C, format: 'U8' },
		iceMakerOperationalState: { id: 0x2D, format: 'U8' }
	};
	
	var message = {
		type: SUBSCRIPTION_MESSAGES[type].id,
		content: {
			numericType: SUBSCRIPTION_MESSAGES[type].format,
			numericValue: data
		}
	};
	
	for (var j in devices) {
		if (devices[j].subscriptions.has(message.type)) {
			console.log('SENDING ' + message.type + ' to ' + devices[j].deviceType);
			devices[j].send(message);
		}
	}
};
