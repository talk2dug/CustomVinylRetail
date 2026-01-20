/**
 * Task Tracker - Server-side state machine for tracking long-running processes
 * Provides real-time progress updates for dashboard display
 */

// In-memory task storage (persists until server restart)
const activeTasks = new Map();
const completedTasks = []; // Keep last 50 completed tasks
const MAX_COMPLETED_TASKS = 50;

/**
 * Task states
 */
const TaskState = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

/**
 * Task types for different processes
 */
const TaskType = {
  STICKER_SHEETS: 'sticker-sheets',
  MASK_GENERATION: 'mask-generation',
  SHOPIFY_SYNC: 'shopify-sync',
  IMAGE_PROCESSING: 'image-processing',
  BULK_UPLOAD: 'bulk-upload',
  COLLECTION_SYNC: 'collection-sync'
};

/**
 * Create a new task
 * @param {string} type - Task type from TaskType
 * @param {string} description - Human-readable description
 * @param {object} metadata - Additional task metadata
 * @returns {string} Task ID
 */
function createTask(type, description, metadata = {}) {
  const taskId = `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const task = {
    id: taskId,
    type,
    description,
    state: TaskState.PENDING,
    progress: 0,
    total: metadata.total || 0,
    current: 0,
    currentItem: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date().toISOString(),
    metadata,
    log: [],
    error: null
  };

  activeTasks.set(taskId, task);
  console.log(`[TaskTracker] Created task: ${taskId} - ${description}`);

  return taskId;
}

/**
 * Start a task
 * @param {string} taskId - Task ID
 * @param {number} total - Total items to process (optional, can be set later)
 */
function startTask(taskId, total = null) {
  const task = activeTasks.get(taskId);
  if (!task) {
    console.error(`[TaskTracker] Task not found: ${taskId}`);
    return;
  }

  task.state = TaskState.RUNNING;
  task.startedAt = new Date().toISOString();
  if (total !== null) {
    task.total = total;
  }

  console.log(`[TaskTracker] Started task: ${taskId} (${task.total} items)`);
}

/**
 * Update task progress
 * @param {string} taskId - Task ID
 * @param {number} current - Current item number
 * @param {string} currentItem - Description of current item being processed
 */
function updateProgress(taskId, current, currentItem = null) {
  const task = activeTasks.get(taskId);
  if (!task) return;

  task.current = current;
  task.currentItem = currentItem;
  task.progress = task.total > 0 ? Math.round((current / task.total) * 100) : 0;
}

/**
 * Add a log entry to a task
 * @param {string} taskId - Task ID
 * @param {string} message - Log message
 */
function logTask(taskId, message) {
  const task = activeTasks.get(taskId);
  if (!task) return;

  task.log.push({
    timestamp: new Date().toISOString(),
    message
  });

  // Keep only last 100 log entries
  if (task.log.length > 100) {
    task.log = task.log.slice(-100);
  }
}

/**
 * Complete a task successfully
 * @param {string} taskId - Task ID
 * @param {object} result - Result data
 */
function completeTask(taskId, result = null) {
  const task = activeTasks.get(taskId);
  if (!task) return;

  task.state = TaskState.COMPLETED;
  task.progress = 100;
  task.completedAt = new Date().toISOString();
  task.result = result;

  // Move to completed tasks
  activeTasks.delete(taskId);
  completedTasks.unshift(task);

  // Trim completed tasks list
  while (completedTasks.length > MAX_COMPLETED_TASKS) {
    completedTasks.pop();
  }

  console.log(`[TaskTracker] Completed task: ${taskId}`);
}

/**
 * Fail a task
 * @param {string} taskId - Task ID
 * @param {string} error - Error message
 */
function failTask(taskId, error) {
  const task = activeTasks.get(taskId);
  if (!task) return;

  task.state = TaskState.FAILED;
  task.completedAt = new Date().toISOString();
  task.error = error;

  // Move to completed tasks
  activeTasks.delete(taskId);
  completedTasks.unshift(task);

  // Trim completed tasks list
  while (completedTasks.length > MAX_COMPLETED_TASKS) {
    completedTasks.pop();
  }

  console.error(`[TaskTracker] Failed task: ${taskId} - ${error}`);
}

/**
 * Cancel a task
 * @param {string} taskId - Task ID
 */
function cancelTask(taskId) {
  const task = activeTasks.get(taskId);
  if (!task) return;

  task.state = TaskState.CANCELLED;
  task.completedAt = new Date().toISOString();

  activeTasks.delete(taskId);
  completedTasks.unshift(task);

  while (completedTasks.length > MAX_COMPLETED_TASKS) {
    completedTasks.pop();
  }

  console.log(`[TaskTracker] Cancelled task: ${taskId}`);
}

/**
 * Get all active tasks
 * @returns {Array} Array of active tasks
 */
function getActiveTasks() {
  return Array.from(activeTasks.values()).map(task => ({
    ...task,
    elapsed: task.startedAt ? getElapsedTime(task.startedAt) : null,
    estimatedRemaining: estimateRemainingTime(task)
  }));
}

/**
 * Get recent completed tasks
 * @param {number} limit - Max number of tasks to return
 * @returns {Array} Array of completed tasks
 */
function getCompletedTasks(limit = 10) {
  return completedTasks.slice(0, limit);
}

/**
 * Get a specific task by ID
 * @param {string} taskId - Task ID
 * @returns {object|null} Task or null if not found
 */
function getTask(taskId) {
  return activeTasks.get(taskId) || completedTasks.find(t => t.id === taskId) || null;
}

/**
 * Get all tasks summary for dashboard
 * @returns {object} Summary object
 */
function getTasksSummary() {
  const active = getActiveTasks();
  const completed = getCompletedTasks(10);

  return {
    activeCount: active.length,
    active,
    recentCompleted: completed,
    serverUptime: process.uptime(),
    timestamp: new Date().toISOString()
  };
}

/**
 * Calculate elapsed time string
 * @param {string} startTime - ISO timestamp
 * @returns {string} Human-readable elapsed time
 */
function getElapsedTime(startTime) {
  const start = new Date(startTime);
  const now = new Date();
  const seconds = Math.floor((now - start) / 1000);

  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * Estimate remaining time based on current progress
 * @param {object} task - Task object
 * @returns {string|null} Estimated time remaining
 */
function estimateRemainingTime(task) {
  if (!task.startedAt || task.current === 0 || task.total === 0) return null;

  const start = new Date(task.startedAt);
  const now = new Date();
  const elapsedMs = now - start;
  const msPerItem = elapsedMs / task.current;
  const remainingItems = task.total - task.current;
  const remainingMs = msPerItem * remainingItems;

  const seconds = Math.floor(remainingMs / 1000);
  if (seconds < 60) return `~${seconds}s`;
  if (seconds < 3600) return `~${Math.floor(seconds / 60)}m`;

  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `~${hours}h ${mins}m`;
}

module.exports = {
  TaskState,
  TaskType,
  createTask,
  startTask,
  updateProgress,
  logTask,
  completeTask,
  failTask,
  cancelTask,
  getActiveTasks,
  getCompletedTasks,
  getTask,
  getTasksSummary
};
