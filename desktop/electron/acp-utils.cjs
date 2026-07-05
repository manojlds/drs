// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */

const buildPermissionResponse = ({ optionId, cancelled } = {}) => {
  const fallbackOption = optionId || (cancelled ? undefined : 'reject-once');
  return {
    outcome: cancelled
      ? { outcome: 'cancelled' }
      : { outcome: 'selected', optionId: fallbackOption },
  };
};

const buildElicitationResponse = ({ action, content } = {}) => {
  if (!['accept', 'decline', 'cancel'].includes(action)) {
    throw new Error('A valid elicitation action is required.');
  }
  return action === 'accept' ? { action, content: content || {} } : { action };
};

module.exports = { buildPermissionResponse, buildElicitationResponse };
