var async = require('async');
var _ = require('underscore');
var parley = require('parley');
var uuid = require('node-uuid');

// (for sorting)
var MAX_INTEGER = 4294967295;

// Read global config
var config = require('./config.js');

// Extend adapter definition
module.exports = function(adapter) {
	var self = this;

	// Absorb configuration
	this.config = _.extend({}, adapter.config || {});

	// Absorb identity
	this.identity = adapter.identity;

	// Initialize is fired once-per-adapter
	this.initialize = function(cb) {
		if (adapter.initialize) adapter.initialize(cb);
		else cb();
	};

	// Logic to handle the (re)instantiation of collections
	this.initializeCollection = function(collectionName, cb) {
		if (adapter.initializeCollection) {
			adapter.initializeCollection.apply(this,arguments);
		}
		else cb && cb();
	};

	// Teardown is fired once-per-adapter
	// (i.e. tear down any remaining connections to the underlying data model)
	this.teardown = function(cb) {

		if (adapter.teardown) adapter.teardown.apply(this,arguments);
		else cb && cb();
	}; 

	// teardownCollection is fired once-per-collection
	// (i.e. flush data to disk before the adapter shuts down)
	this.teardownCollection = function(collectionName,cb) {
		if (adapter.teardownCollection) {
			adapter.teardownCollection.apply(this,arguments);
		}
		else cb && cb();
	};



	//////////////////////////////////////////////////////////////////////
	// DDL
	//////////////////////////////////////////////////////////////////////
	this.define = function(collectionName, definition, cb) {

		// Grab attributes from definition
		var attributes = definition.attributes || {};

		// Marshal attributes to a standard format
		attributes = require('./augmentAttributes')(attributes,this.config);

		// Verify that collection doesn't already exist
		// and then define it and trigger callback
		this.describe(collectionName, function(err, existingAttributes) {
			if(err) return cb(err, attributes);
			else if(existingAttributes) return cb("Trying to define a collection (" + collectionName + ") which already exists.");
			
			if (adapter.define) adapter.define(collectionName, attributes, cb);
			else cb();
		});
	};

	this.describe = function(collectionName, cb) {
		if (adapter.describe) {
			adapter.describe.apply(this,arguments);
		}
		else cb();
	};
	this.drop = function(collectionName, cb) {
		if (adapter.drop) {
			adapter.drop.apply(this,arguments);
		}
		else cb();
	};
	this.alter = function(collectionName, attributes, cb) {
		var self = this;

		// If the adapter defines alter, use that
		if (adapter.alter) {
			adapter.alter.apply(this,arguments);
		}
		// If the adapter defines column manipulation, use it
		else if (adapter.addAttribute && adapter.removeAttribute) {
			// Update the data belonging to this attribute to reflect the new properties
			// Realistically, this will mainly be about constraints, and primarily uniquness
			// It'd be good if waterline could enforce all constraints at this time,
			// but there's a trade-off with destroying people's data
			// TODO: Figure this out

			// Alter the schema
			self.describe(collectionName, function afterDescribe (err, originalAttributes) {
				if (err) return done(err);

				// Keep track of previously undefined attributes
				// for use when updating the actual data
				var newAttributes = {};

				// Iterate through each attribute in the new definition
				// If the attribute doesn't exist, mark it as a new attribute
				_.each(attributes, function checkAttribute(attribute,attrName) {
					if (!originalAttributes[attrName]) {
						newAttributes[attrName] = attribute;
					}
				});

				// Keep track of attributes which no longer exist or which need to be changed
				var deprecatedAttributes = {};
				_.each(originalAttributes,function (attribute,attrName) {
					if (! attributes[attrName]) {
						deprecatedAttributes[attrName] = attribute;
					}
					// Remove and recreate the attribute
					if ( !_.isEqual(attributes[attrName],attribute) ) {
						deprecatedAttributes[attrName] = attribute;
						newAttributes[attrName] = attribute;
					}
				});

				// Add and remove attributes using the specified adapter
				async.forEach(_.keys(newAttributes), function (attrName, cb) {
					adapter.addAttribute(collectionName, attrName, newAttributes[attrName], cb);
				}, function (err) {
					if (err) throw err;
					async.forEach(_.keys(deprecatedAttributes), function (attrName, cb) {
						adapter.removeAttribute(collectionName, attrName, deprecatedAttributes[attrName], cb);
					}, cb);
				});
			});
		}
		// Otherwise don't do anything, it's too dangerous 
		// (dropping and readding the data could cause corruption if the user stops the server midway through)
		else cb();
	};


	//////////////////////////////////////////////////////////////////////
	// DQL
	//////////////////////////////////////////////////////////////////////
	this.create = function(collectionName, values, cb) {
		if(!adapter.create) return cb("No create() method defined in adapter!");

		// TODO: Populate default values
		// (just use describe(), but first we need an in-memory cache for calls to describe())

		// TODO: Validate constraints using Anchor
		
		// Automatically add updatedAt and createdAt (if enabled)
		if (self.config.createdAt) values.createdAt = new Date();
		if (self.config.updatedAt) values.updatedAt = new Date();

		adapter.create(collectionName, values, cb);
	};

	// Find a set of models
	this.findAll = function(collectionName, criteria, cb) {
		if(!adapter.find) return cb("No find() method defined in adapter!");
		criteria = normalizeCriteria(criteria);
		if (_.isString(criteria)) return cb(criteria);
		adapter.find(collectionName, criteria, cb);
	};

	// Find exactly one model
	this.find = function(collectionName, criteria, cb) {
		// If no criteria specified, use first model
		if (!criteria) criteria = {limit: 1};

		this.findAll(collectionName, criteria, function (err, models) {
			if (models.length < 1) return cb();
			else if (models.length > 1) return cb("More than one "+collectionName+" returned!");
			else return cb(null,models[0]);
		});
	};

	this.count = function(collectionName, criteria, cb) {
		var self = this;
		criteria = normalizeCriteria(criteria);
		if (!adapter.count) {
			self.findAll(collectionName, criteria, function (err,models){
				cb(err,models.length);
			});
		}
		else adapter.count(collectionName, criteria, cb);
	};

	this.update = function(collectionName, criteria, values, cb) {
		if(!adapter.update) return cb("No update() method defined in adapter!");
		criteria = normalizeCriteria(criteria);
		if (_.isString(criteria)) return cb(criteria);

		// TODO: Validate constraints using Anchor

		// Automatically change updatedAt (if enabled)
		if (self.config.updatedAt) values.updatedAt = new Date();

		adapter.update(collectionName, criteria, values, cb);

		// TODO: Return model instance Promise object for joins, etc.
	};
	this.destroy = function(collectionName, criteria, cb) {
		if(!adapter.destroy) return cb("No destroy() method defined in adapter!");
		criteria = normalizeCriteria(criteria);
		if (_.isString(criteria)) return cb(criteria);

		adapter.destroy(collectionName, criteria, cb);

		// TODO: Return model instance Promise object for joins, etc.
	};

	//////////////////////////////////////////////////////////////////////
	// Compound methods (overwritable in adapters)
	//////////////////////////////////////////////////////////////////////
	this.findOrCreate = function(collectionName, criteria, values, cb) {
		var self = this;
		criteria = normalizeCriteria(criteria);
		if (_.isString(criteria)) return cb(criteria);

		// If no values were specified, use criteria
		if (!values) values = criteria.where;

		if(adapter.findOrCreate) {
			adapter.findOrCreate(collectionName, criteria, values, cb);
		}
		
		// Default behavior
		// Warning: Inefficient!  App-level tranactions should not be used for built-in compound queries.
		else {
			// Create transaction name based on collection
			var transactionName = collectionName+'.waterline.default.create.findOrCreate';
			self.transaction(transactionName, function (err,done) {
				self.find(collectionName, criteria, function(err, result) {
					if(err) done(err);
					else if(result) done(null, result);
					else self.create(collectionName, values, done);
				});
			}, cb);
		}

		// TODO: Return model instance Promise object for joins, etc.
	};


	//////////////////////////////////////////////////////////////////////
	// Aggregate
	//////////////////////////////////////////////////////////////////////

	// If an optimized createEach exists, use it, otherwise use an asynchronous loop with create()
	this.createEach = function (collectionName, valuesList, cb) {
		var my = this;

		// Custom user adapter behavior
		if (adapter.createEach) adapter.createEach.apply(this,arguments);
		
		// Default behavior
		else {
			// Create transaction name based on collection
			my.transaction(collectionName+'..waterline.default.createEach', function (err,done) {
				async.forEach(valuesList, function (values,cb) {
					my.create(collectionName, values, cb);
				}, done);
			},cb);
		}
	};
	// If an optimized findOrCreateEach exists, use it, otherwise use an asynchronous loop with create()
	this.findOrCreateEach = function (collectionName, valuesList, cb) {
		var my = this;

		// Custom user adapter behavior
		if (adapter.findOrCreateEach) adapter.findOrCreateEach(collectionName,valuesList,cb);
		
		// Default behavior
		else {
			// Create transaction name based on collection
			my.transaction(collectionName+'.waterline.default.createEach', function (err,done) {
				async.forEach(valuesList, function (values,cb) {
					my.findOrCreate(collectionName, values, null, cb);
				}, done);
			},cb);
		}
	};



	//////////////////////////////////////////////////////////////////////
	// Concurrency
	//////////////////////////////////////////////////////////////////////
	
	/**
	*	App-level transaction
	*	@transactionName		a unique identifier for this transaction
	*	@atomicLogic		the logic to be run atomically
	*	@afterUnlock (optional)	the function to trigger after unlock() is called
	*/
	this.transaction = function(transactionName, atomicLogic, afterUnlock) {
		var self = this;

		// Generate unique lock
		var newLock = {
			uuid: uuid.v4(),
			name: transactionName,
			atomicLogic: atomicLogic,
			afterUnlock: afterUnlock
		};

		// write new lock to commit log
		this.transactionCollection.create(newLock, function afterCreatingTransaction(err, newLock) {
			if(err) return atomicLogic(err, function() {
				throw err;
			});

			// Check if lock was written, and is the oldest with the proper name
			self.transactionCollection.findAll(function afterLookingUpTransactions(err, locks) {
				if(err) return atomicLogic(err, function() {
					throw err;
				});

				var conflict = false;
				_.each(locks, function eachLock (entry) {

					// If a conflict IS found, respect the oldest
					if(entry.name === newLock.name && 
						entry.uuid !== newLock.uuid && 
						entry.id < newLock.id) conflict = entry;
				});

				// If there are no conflicts, the lock is acquired!
				if(!conflict) acquireLock(newLock);

				// Otherwise, get in line: a lock was acquired before mine, do nothing
				

			});
		});
	};

	/**
	* acquireLock() is run after the lock is acquired, but before passing control to the atomic app logic
	*
	* @newLock					the object representing the lock to acquire
		* @name						name of the lock
		* @atomicLogic				the transactional logic to be run atomically
		* @afterUnlock (optional)	the function to run after the lock is subsequently released
	*/
	var acquireLock = function(newLock) {

		var warningTimer = setTimeout(function() {
			console.error("Transaction :: " + newLock.name + " is taking an abnormally long time (> " + self.config.transactionWarningTimer + "ms)");
		}, self.config.transactionWarningTimer);

		newLock.atomicLogic(null, function unlock () {
			clearTimeout(warningTimer);
			releaseLock(newLock,arguments);
		});
	};


	// releaseLock() will grant pending lock requests in the order they were received
	//
	// @currentLock			the lock currently acquired
	// @afterUnlockArgs		the arguments to pass to the afterUnlock function 
	var releaseLock = function(currentLock, afterUnlockArgs) {

		var cb = currentLock.afterUnlock;

		// Get all locks
		self.transactionCollection.findAll(function afterLookingUpTransactions(err, locks) {
			if(err) return cb && cb(err);
			
			// Determine the next user in line
			// (oldest lock that isnt THIS ONE w/ the proper transactionName)
			var nextInLine = getNextLock(locks, currentLock);

			// Remove current lock
			self.transactionCollection.destroy({
				uuid: currentLock.uuid
			}, function afterLockReleased (err) {
				if(err) return cb && cb(err);

				// Trigger unlock's callback if specified
				// > NOTE: do this before triggering the next queued transaction
				// to prevent transactions from monopolizing the event loop
				cb && cb.apply(null, afterUnlockArgs);

				// Now allow the nextInLine lock to be acquired
				// This marks the end of the previous transaction
				nextInLine && acquireLock(nextInLine);
			});
		});
	};



	// If @collectionName and @otherCollectionName are both using this adapter, do a more efficient remote join.
	// (By default, an inner join, but right and left outer joins are also supported.)
	this.join = function(collectionName, otherCollectionName, key, foreignKey, left, right, cb) {
		adapter.join ? adapter.join(collectionName, otherCollectionName, key, foreignKey, left, right, cb) : cb();
	};

	// Sync given collection's schema with the underlying data model
	// Controls whether database is dropped and recreated when app starts,
	// or whether waterline will try and synchronize the schema with the app models.
	this.sync = {

		// Drop and recreate collection
		drop: function(collection, cb) {
			var self = this;
			this.drop(collection.identity, function afterDrop (err, data) {
				if(err) cb(err);
				else self.define(collection.identity, collection, cb);
			});
		},

		// Alter schema
		alter: function(collection, cb) {
			var self = this;

			// Check that collection exists-- if it doesn't go ahead and add it and get out
			this.describe(collection.identity, function afterDescribe (err, attrs) {
				attrs = _.clone(attrs);
				if(err) return cb(err);
				else if(!attrs) return self.define(collection.identity, collection, cb);

				// Otherwise, if it *DOES* exist, we'll try and guess what changes need to be made
				else self.alter(collection.identity, collection.attributes, cb);
			});
		}, 

		// Do nothing to the underlying data model
		safe: function (collection,cb) {
			cb();
		}
	};

	// Bind adapter methods to self
	_.bindAll(adapter);
	_.bindAll(this);
	_.bind(this.sync.drop, this);
	_.bind(this.sync.alter, this);

	// Mark as valid adapter
	this._isWaterlineAdapter = true;
};


// Find the oldest lock with the same transaction name
// ************************************************************
//	this function wouldn't be necessary if we could....
//	TODO:  call find() with the [currently unfinished] ORDER option
// ************************************************************
function getNextLock(locks, currentLock) {
	var nextLock;
	_.each(locks, function(lock) {

		// Ignore locks with different transaction names
		if (lock.name !== currentLock.name) return;
		
		// Ignore current lock
		if (lock.uuid === currentLock.uuid) return;

		// Find the lock with the smallest id
		var minId = nextLock ? nextLock.id : MAX_INTEGER;
		if (lock.id < minId) nextLock = lock;
	});
	return nextLock;
}

/**
 * Run a method on an object -OR- each item in an array and return the result
 * Also handle errors gracefully
 */

function plural(collection, application) {
	if(_.isArray(collection)) {
		return _.map(collection, application);
	} else if(_.isObject(collection)) {
		return application(collection);
	} else {
		throw "Invalid collection passed to plural aggreagator:" + collection;
	}
}

// Normalize the different ways of specifying criteria into a uniform object

function normalizeCriteria(criteria) {
	if(!criteria) return {
		where: null
	};

	// Empty undefined values from criteria object
	_.each(criteria, function(val, key) {
		if(_.isUndefined(val)) delete criteria[key];
	});

	// Convert id and id strings into a criteria
	if((_.isFinite(criteria) || _.isString(criteria)) && +criteria > 0) {
		criteria = {
			id: +criteria
		};
	}

	// Return string to indicate an error
	if(!_.isObject(criteria)) return ('Invalid options/criteria :: ' + criteria);

	// If criteria doesn't seem to contain operational keys, assume all the keys are criteria
	if(!criteria.where && !criteria.limit && !criteria.skip && !criteria.offset && !criteria.order) {
		criteria = {
			where: criteria
		};
	}

	// If any item in criteria is a parsable finite number, use that
	for(var attrName in criteria.where) {
		if(Math.pow(+criteria.where[attrName], 2) > 0) {
			criteria.where[attrName] = +criteria.where[attrName];
		}
	}

	// Normalize sort criteria
	if (criteria.sort) {
		// Split string into attr and sortDirection parts (default to 'asc')
		if (_.isString(criteria.sort)) {
			var parts = _.str.words(criteria.sort);
			parts[1] = parts[1] ? parts[1].toLowerCase() : 'asc';
			if (parts.length !== 2 || (parts[1] !== 'asc' && parts[1] !== 'desc')) {
				throw new Error ('Invalid sort criteria :: '+criteria.sort);
			}
			criteria.sort = {};
			criteria.sort[parts[0]] = (parts[1] === 'asc') ? 1 : -1;
		}

		// Verify that user either specified a proper object
		// or provided explicit comparator function
		if (!_.isObject(criteria.sort) && !_.isFunction(criteria.sort)) {
			throw new Error ('Invalid sort criteria for '+attrName+' :: '+direction);
		}

	}

	return criteria;
}