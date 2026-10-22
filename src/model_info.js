/**
 * What this program tells a client about every model besides its name. The websites publish no limits for their chats, and the only figures to be found are
 * secondhand API limits (about 1M tokens of context for the models these chats run), which a chat does not necessarily accept. So the size listed here is
 * one conservative WORKING size chosen by this program: a size a client can plan its prompts around, not the model's maximum. It lives in this one place.
 */
'use strict';

const WORKING_CONTEXT_TOKENS = 128000;

/** The model as a client sees it: with its working context size unless the provider knows better. */
function withContext(model) {
  return { ...model, context_length: model.context_length || WORKING_CONTEXT_TOKENS };
}

module.exports = { WORKING_CONTEXT_TOKENS, withContext };
