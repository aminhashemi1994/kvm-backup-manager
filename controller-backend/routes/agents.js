const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getAgents, saveAgents } = require('../services/fileStorage');
const agentService = require('../services/agentService');
const { validateAgent } = require('../utils/validator');

// GET /api/agents - List all agents
router.get('/', async (req, res, next) => {
  try {
    const agents = await getAgents();
    res.json({ success: true, data: agents });
  } catch (error) {
    next(error);
  }
});

// GET /api/agents/:id - Get single agent
router.get('/:id', async (req, res, next) => {
  try {
    const agents = await getAgents();
    const agent = agents.find(a => a.id === req.params.id);
    
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    
    res.json({ success: true, data: agent });
  } catch (error) {
    next(error);
  }
});

// POST /api/agents - Add new agent
router.post('/', async (req, res, next) => {
  try {
    const validation = validateAgent(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ success: false, errors: validation.errors });
    }

    const agents = await getAgents();
    
    // Check if agent with same URL exists
    const exists = agents.find(a => a.url === req.body.url);
    if (exists) {
      return res.status(400).json({ success: false, error: 'Agent with this URL already exists' });
    }

    // Test connection before adding
    const healthResult = await agentService.healthCheck(req.body.url);
    
    const newAgent = {
      id: uuidv4(),
      name: req.body.name,
      url: req.body.url,
      description: req.body.description || '',
      status: healthResult.success ? 'online' : 'offline',
      lastHealthCheck: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    agents.push(newAgent);
    await saveAgents(agents);

    res.status(201).json({ 
      success: true, 
      data: newAgent,
      healthCheck: healthResult,
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/agents/:id - Update agent
router.put('/:id', async (req, res, next) => {
  try {
    const agents = await getAgents();
    const index = agents.findIndex(a => a.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    const validation = validateAgent(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ success: false, errors: validation.errors });
    }

    agents[index] = {
      ...agents[index],
      name: req.body.name,
      url: req.body.url,
      description: req.body.description || agents[index].description,
      updatedAt: new Date().toISOString(),
    };

    await saveAgents(agents);
    res.json({ success: true, data: agents[index] });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/agents/:id - Delete agent
router.delete('/:id', async (req, res, next) => {
  try {
    const agents = await getAgents();
    const index = agents.findIndex(a => a.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    const deleted = agents.splice(index, 1)[0];
    await saveAgents(agents);

    res.json({ success: true, data: deleted });
  } catch (error) {
    next(error);
  }
});

// POST /api/agents/:id/health-check - Health check for agent
router.post('/:id/health-check', async (req, res, next) => {
  try {
    const agents = await getAgents();
    const agent = agents.find(a => a.id === req.params.id);
    
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    const result = await agentService.healthCheck(agent.url);
    
    // Update agent status
    agent.status = result.success ? 'online' : 'offline';
    agent.lastHealthCheck = new Date().toISOString();
    await saveAgents(agents);

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
