/**
 * Room Groups Server
 * API routes for room group CRUD operations
 * Handles creating, updating, deleting groups and managing group membership
 * (Mirrors model-groups.js pattern for metal print pipeline)
 */

const url = require('url');
const { parseBody, sendJson, sendError, handleOptions } = require('./utils/http');

/**
 * Handle Room Groups API routes
 * @param {string} pathname - URL pathname
 * @param {object} req - HTTP request
 * @param {object} res - HTTP response
 * @param {object} db - Database module
 */
async function handleRoomGroupsRoute(pathname, req, res, db) {
  const basePath = '/api/custom-art/room-groups';
  if (!pathname.startsWith(basePath)) return false;
  const route = pathname.slice(basePath.length) || '/';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    handleOptions(res);
    return true;
  }

  // GET /api/custom-art/room-groups — list all groups with member counts
  if (route === '/' && req.method === 'GET') {
    const groups = db.listRoomGroups();
    sendJson(res, 200, { success: true, groups });
    return true;
  }

  // POST /api/custom-art/room-groups — create a new group
  if (route === '/' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.name || !body.name.trim()) {
      sendError(res, 400, 'Group name is required');
      return true;
    }
    try {
      const group = db.createRoomGroup({ name: body.name.trim(), description: body.description || '' });
      if (Array.isArray(body.rooms) && body.rooms.length) {
        db.addRoomsToGroup(group.id, body.rooms);
      }
      const members = db.getRoomGroupMembers(group.id);
      sendJson(res, 201, { success: true, group, members });
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        sendError(res, 409, 'A room group with that name already exists');
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

  // GET /api/custom-art/room-groups/:id — get group detail with members
  if (subRoute === '/' && req.method === 'GET') {
    const group = db.getRoomGroupById(groupId);
    if (!group) { sendError(res, 404, 'Room group not found'); return true; }
    const members = db.getRoomGroupMembers(groupId);
    sendJson(res, 200, { success: true, group, members });
    return true;
  }

  // PUT /api/custom-art/room-groups/:id — update group metadata
  if (subRoute === '/' && req.method === 'PUT') {
    const group = db.getRoomGroupById(groupId);
    if (!group) { sendError(res, 404, 'Room group not found'); return true; }
    const body = await parseBody(req);
    const updated = db.updateRoomGroup(groupId, { name: body.name, description: body.description });
    sendJson(res, 200, { success: true, group: updated });
    return true;
  }

  // DELETE /api/custom-art/room-groups/:id — delete group
  if (subRoute === '/' && req.method === 'DELETE') {
    const deleted = db.deleteRoomGroup(groupId);
    sendJson(res, 200, { success: true, deleted });
    return true;
  }

  // POST /api/custom-art/room-groups/:id/members — add rooms to group
  if (subRoute === '/members' && req.method === 'POST') {
    const group = db.getRoomGroupById(groupId);
    if (!group) { sendError(res, 404, 'Room group not found'); return true; }
    const body = await parseBody(req);
    if (!Array.isArray(body.rooms) || !body.rooms.length) {
      sendError(res, 400, 'rooms array required (roomId strings or {roomId, roomType, multiPrint} objects)');
      return true;
    }
    db.addRoomsToGroup(groupId, body.rooms);
    const members = db.getRoomGroupMembers(groupId);
    sendJson(res, 200, { success: true, added: body.rooms.length, members });
    return true;
  }

  // DELETE /api/custom-art/room-groups/:id/members — remove rooms from group
  // Also supports POST /members/remove since some clients don't support DELETE with body
  if ((subRoute === '/members' && req.method === 'DELETE') || (subRoute === '/members/remove' && req.method === 'POST')) {
    const group = db.getRoomGroupById(groupId);
    if (!group) { sendError(res, 404, 'Room group not found'); return true; }
    const body = await parseBody(req);
    if (!Array.isArray(body.roomIds) || !body.roomIds.length) {
      sendError(res, 400, 'roomIds array required');
      return true;
    }
    db.removeRoomsFromGroup(groupId, body.roomIds);
    const members = db.getRoomGroupMembers(groupId);
    sendJson(res, 200, { success: true, removed: body.roomIds.length, members });
    return true;
  }

  return false;
}

module.exports = { handleRoomGroupsRoute };
