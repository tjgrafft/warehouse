'use strict';

const express = require('express');
const router = express.Router();
const jwt = require('express-jwt');
const winston = require('winston');
const async = require('async');
const fs = require('fs');
const request = require('request');

const config = require('../config');
const logger = winston.createLogger(config.logger.winston);
const db = require('../models');
const common = require('../common');
const mongoose = require('mongoose');

/*
//check if user can publish this project
function can_publish(req, project_id, cb) {
    //TODO - why does this exist?
    if(typeof project_id === 'string') project_id = mongoose.Types.ObjectId(project_id);
    
    //check user has access to the project
    common.getprojects(req.user, function(err, canread_project_ids, canwrite_project_ids) {
        if(err) return cb(err);
        let found = canwrite_project_ids.find(id=>id.equals(project_id));
        cb(null, found);
    });
}
*/

/**
 * @apiGroup Pipeline Rules
 * @api {get} /rule             Query pipeline rules
 *
 * @apiParam {Object} [find]    Optional Mongo find query - defaults to {}
 * @apiParam {Object} [sort]    Optional Mongo sort object - defaults to {}
 * @apiParam {String} [select]  Fields to load - multiple fields can be entered with %20 as delimiter
 * @apiParam {String} [populate] Relational fields to populate
 * @apiParam {Number} [limit]   Optional Maximum number of records to return - defaults to 0(no limit)
 * @apiParam {Number} [skip]    Optional Record offset for pagination
 *
 * @apiSuccess {Object}         List of rules (maybe limited / skipped) and total count
 */
router.get('/', jwt({secret: config.express.pubkey}), (req, res, next)=>{
    let find = {};
	let skip = req.query.skip || 0;
	let limit = req.query.limit || 100;

    //TODO - should I only allow querying rules for public or accessible private project?

    if(req.query.find) find = JSON.parse(req.query.find);
    db.Rules.find(find)
    .populate(req.query.populate || '') //all by default
    .select(req.query.select)
    .limit(+limit)
    .skip(+skip)
    .sort(req.query.sort || '_id')
    .lean()
    .exec((err, rules)=>{
        if(err) return next(err);
        db.Datatypes.countDocuments(find).exec((err, count)=>{
            if(err) return next(err);
            res.json({rules, count});
        });
    });
});

/**
 * @apiGroup Pipeline Rules
 * @api {get} /rule/log/:ruleid     Get the latest rule execution log
 *
 * @apiSuccess String               Return string containing the entire log
 */
router.get('/log/:ruleid', jwt({secret: config.express.pubkey}), (req, res, next)=>{
    db.Rules.findById(req.params.ruleid)
    .exec((err, rule)=>{
        if(err) return next(err);
        if(!rule) return next("no such rule");
        check_access(req, rule, err=>{
            if(err) return next(err);
            let logpath = config.warehouse.rule_logdir+"/"+rule._id.toString()+".log";
            fs.stat(logpath, (err, stats)=>{
                if(err) return res.status(500).json({err});
                let logs = fs.readFileSync(logpath, 'ascii');
                res.json({stats, logs});
            });
        });
    });
});

function check_access(req, rule, cb) {
    //TODO - make sure user has access to req.body.app?
    //console.log(JSON.stringify(rule, null, 4));
    
    //check user has access to the project
    common.getprojects(req.user, function(err, canread_project_ids, canwrite_project_ids) {
        if(err) return cb(err);
        let project_id = mongoose.Types.ObjectId(rule.project);
        let found = canwrite_project_ids.find(id=>id.equals(rule.project));
        if(!found) return cb("can't access rule under this project");

        //check to see if user has read accesses to all input_project_override 
        if(rule.input_project_override) for(let id in rule.input_project_override) {
            let project_id = rule.input_project_override[id];
            if(!project_id) continue; //ignore null..
            let o_project_id = mongoose.Types.ObjectId(project_id); //null gets converted to a valid mongoose id.. new id?)
            let found = canread_project_ids.find(id=>id.equals(o_project_id));
            if(!found) return cb("can't use project selected in override:"+o_project_id+" for id:"+id);
        }

        cb(); //a-ok
    });
}

/**
 * @apiGroup Pipeline Rules
 * @api {post} /rule/:pubid         Register new rule
 *                              
 * @apiDescription                  Register a new pipeline rule.
 *
 * @apiParam {String} name          Rule name
 * @apiParam {String} desc          Rule description
 * @apiParam {String} project       Project ID
 * @apiParam {Object} input_tags    Input Tags
 * @apiParam {Object} output_tags   Output Tags
 * @apiParam {Object} input_project_override 
 *                                  Input project override
 * @apiParam {String} app           Application ID
 * @apiParam {String} branch        Application branch to use
 * @apiParam {Boolean} active       Active flag
 * @apiParam {String} subject_match Subject match
 * @apiParam {String} session_match Session match
 * @apiParam {Object} config        Application configuration
 *
 * @apiHeader {String} authorization 
 *                                  A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}             Created rule object
 */
router.post('/', jwt({secret: config.express.pubkey}), (req, res, next)=>{
    if(!req.body.project) return next("project id not set");
    if(!req.body.app) return next("app id not set");
    check_access(req, req.body, err=>{
        if(err) return next(err);
        let override = {
            user_id: req.user.sub,
            create_date: new Date(),
        }
        new db.Rules(Object.assign(req.body, override)).save((err, rule)=>{
            if(err) return next(err);
            common.publish("rule.create."+req.user.sub+"."+req.body.project+"."+rule._id, {})
            res.json(rule); 
        });
    });
});

/**
 * @apiGroup Pipeline Rules
 * @api {put} /rule/:pubid          Update Rule
 *                              
 * @apiDescription                  Update pipeline rule
 *
 * @apiParam {String} name          Rule name
 * @apiParam {String} desc          Rule description
 * @apiParam {String} project       Project ID
 * @apiParam {Object} input_tags    Input Tags
 * @apiParam {Object} output_tags   Output Tags
 * @apiParam {Object} input_project_override 
 *                                  Input project override
 * @apiParam {String} app           Application ID
 * @apiParam {String} branch        Application branch to use
 * @apiParam {Object} extra_datatype_tags 
 *                                  Datatype tags to add to each inputs
 * @apiParam {String} subject_match Subject match
 * @apiParam {String} session_match Session match
 * @apiParam {Object} config        Application configuration
 *
 * @apiParam {Boolean} removed      If this is a removed publication
 * @apiParam {Boolean} active       active/deactive
 *
 * @apiHeader {String} authorization 
 *                              A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}             Updated Rule
 */
router.put('/:id', jwt({secret: config.express.pubkey}), (req, res, next)=>{
    var id = req.params.id;
    db.Rules.findById(id, (err, rule)=>{
        if(err) return next(err);
        if(!rule) return res.status(404).end();
        check_access(req, rule, err=>{
            if(err) next(err);
            //disallow user from making changes to protected fields
            delete req.body.user_id;
            delete req.body.project;
            delete req.body.create_date;
            
            //update rule record
            for(let k in req.body) rule[k] = req.body[k];
            rule.update_date = new Date();
            rule.save((err, _rule)=>{
                if(err) return next(err);
                common.publish("rule.update."+req.user.sub+"."+rule.project+"."+rule._id, _rule)
                res.json(_rule); 
            });
        });
    });
});

/**
 * @apiGroup Pipeline Rules
 * @api {put} /rule/:id/deactivate
 *                              Deactivate the rule
 * @apiDescription              Removed all running/requested tasks
 *
 * @apiHeader {String} authorization 
 *                              A valid JWT token "Bearer: xxxxx"
 */
router.put('/deactivate/:id', jwt({secret: config.express.pubkey}), function(req, res, next) {
    const id = req.params.id;
    db.Rules.findById(id, function(err, rule) {
        if(err) return next(err);
        if(!rule) return next(new Error("can't find the rule with id:"+id));
        
        //check user has access to the project
        common.getprojects(req.user, function(err, canread_project_ids, canwrite_project_ids) {
            if(err) return next(err);
            let found = canwrite_project_ids.find(id=>id.equals(rule.project));
            if(!found) return next("you are not allowed to edit this rule");
            rule.active = false;
            rule.save(function(err) {
                if(err) return next(err);
                common.publish("rule.update."+req.user.sub+"."+rule.project+"."+rule._id, rule)
                //res.json({status: "ok"});
                //I need to wait for the rule_handler to finish its cycle before I start removing tasks..
                //for now, I am going to give 5 seconds 
                //TODO - maybe I should wait for event from rule_handler?
                logger.debug("waiting for rule handler to finish processing for the current round");
                common.wait_for_event("warehouse.rule", "done", (err, message)=>{
                    //logger.debug(JSON.stringify(message, null, 4));
                    request.get({ url: config.amaretti.api+"/task", json: true, headers: { authorization: req.headers.authorization },
                        qs: {
                            find: JSON.stringify({
                                'config._rule.id': rule._id,
                                //'config._app': {$exists: true}, //don't want to remove staging task (might be used by other rules)
                                status: {$ne: "removed"},
                            }),
                            limit: 5000, //big enough to grab all tasks?
                        },
                    }, (err, _res, data)=>{
                        if(err) return cb(err);
                        //console.dir(data.tasks);
                        async.eachSeries(data.tasks, (task, next_task)=>{
                            logger.debug("removing task %s", task._id.toString());
                            request.delete({url: config.amaretti.api+"/task/"+task._id, json: true, headers: { authorization: req.headers.authorization }}, next_task);
                        }, err=>{
                            if(err) return next(err);
                            res.json({status: "ok"});
                        });
                    });
                });
            });  
        });
    });
});

/**
 * @apiGroup Pipeline Rules
 * @api {delete} /rule/:id
 *                              Set rule's removed flag to true
 * @apiDescription              Logically remove dataset by setting "removed" to true
 *
 * @apiHeader {String} authorization 
 *                              A valid JWT token "Bearer: xxxxx"
 */
router.delete('/:id', jwt({secret: config.express.pubkey}), function(req, res, next) {
    const id = req.params.id;
    db.Rules.findById(id, function(err, rule) {
        if(err) return next(err);
        if(!rule) return next(new Error("can't find the rule with id:"+id));
        
        //check user has access to the project
        common.getprojects(req.user, function(err, canread_project_ids, canwrite_project_ids) {
            if(err) return next(err);
            //console.dir(rule.project);
            let found = canwrite_project_ids.find(id=>id.equals(rule.project));
            if(!found) return next("you are not allowed to edit this rule");
            //rule.remove_date = new Date();
            rule.removed = true;
            rule.save(function(err) {
                if(err) return next(err);
                common.publish("rule.update."+req.user.sub+"."+rule.project+"."+rule._id, rule)
                res.json({status: "ok"});
            }); 
        });
    });
});

module.exports = router;

