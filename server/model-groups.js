/**
 * Model Groups Server
 * API routes for model group CRUD operations
 * Handles creating, updating, deleting groups and managing group membership
 */

const url = require('url');
const { parseBody, sendJson, sendError, handleOptions } = require('./utils/http');

/**
 * Handle Model Groups API routes
 * @param {string} pathname - URL pathname
 * @param {object} req - HTTP request
 * @param {object} res - HTTP response
 * @param {object} db - Database module (db.db for raw instance)
 */
async function handleModelGroupsRoute(pathname, req, res, db) {
  const basePath = '/api/model-groups';
  if (!pathname.startsWith(basePath)) return false;
  const route = pathname.slice(basePath.length) || '/';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    handleOptions(res);
    return true;
  }

  // GET /api/model-groups — list all groups with member counts
  if (route === '/' && req.method === 'GET') {
    const groups = db.listModelGroups();
    sendJson(res, 200, { success: true, groups });
    return true;
  }

  // POST /api/model-groups — create a new group
  if (route === '/' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.name || !body.name.trim()) {
      sendError(res, 400, 'Group name is required');
      return true;
    }
    try {
      const group = db.createModelGroup({ name: body.name.trim(), description: body.description || '' });
      if (Array.isArray(body.modelIds) && body.modelIds.length) {
        db.addModelsToGroup(group.id, body.modelIds);
      }
      const members = db.getModelGroupMembers(group.id);
      sendJson(res, 201, { success: true, group, members });
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        sendError(res, 409, 'A group with that name already exists');
      } else {
        throw err;
      }
    }
    return true;
  }

  // Routes with :id
  const idMatch = route.match(/^\/([^/]+)/);
  if (!idMatch) return false;
  const groupId = decodeURIComponent(idMatch[1]);
  const subRoute = route.slice(idMatch[0].length) || '/';

  // GET /api/model-groups/:id — get group detail with members
  if (subRoute === '/' && req.method === 'GET') {
    const group = db.getModelGroupById(groupId);
    if (!group) { sendError(res, 404, 'Group not found'); return true; }
    const members = db.getModelGroupMembers(groupId);
    sendJson(res, 200, { success: true, group, members });
    return true;
  }

  // PUT /api/model-groups/:id — update group metadata
  if (subRoute === '/' && req.method === 'PUT') {
    const group = db.getModelGroupById(groupId);
    if (!group) { sendError(res, 404, 'Group not found'); return true; }
    const body = await parseBody(req);
    const updated = db.updateModelGroup(groupId, { name: body.name, description: body.description });
    sendJson(res, 200, { success: true, group: updated });
    return true;
  }

  // DELETE /api/model-groups/:id — delete group
  if (subRoute === '/' && req.method === 'DELETE') {
    const deleted = db.deleteModelGroup(groupId);
    sendJson(res, 200, { success: true, deleted });
    return true;
  }

  // POST /api/model-groups/:id/models — add models to group
  if (subRoute === '/models' && req.method === 'POST') {
    const group = db.getModelGroupById(groupId);
    if (!group) { sendError(res, 404, 'Group not found'); return true; }
    const body = await parseBody(req);
    if (!Array.isArray(body.modelIds) || !body.modelIds.length) {
      sendError(res, 400, 'modelIds array required');
      return true;
    }
    db.addModelsToGroup(groupId, body.modelIds);
    const members = db.getModelGroupMembers(groupId);
    sendJson(res, 200, { success: true, added: body.modelIds.length, members });
    return true;
  }

  // DELETE /api/model-groups/:id/models — remove models from group
  // Also supports POST /models/remove since some clients don't support DELETE with body
  if ((subRoute === '/models' && req.method === 'DELETE') || (subRoute === '/models/remove' && req.method === 'POST')) {
    const group = db.getModelGroupById(groupId);
    if (!group) { sendError(res, 404, 'Group not found'); return true; }
    const body = await parseBody(req);
    if (!Array.isArray(body.modelIds) || !body.modelIds.length) {
      sendError(res, 400, 'modelIds array required');
      return true;
    }
    db.removeModelsFromGroup(groupId, body.modelIds);
    const members = db.getModelGroupMembers(groupId);
    sendJson(res, 200, { success: true, removed: body.modelIds.length, members });
    return true;
  }

  return false;
}

module.exports = { handleModelGroupsRoute };
