/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

foam.CLASS({
  package: 'foam.core.ai.llm.provider',
  name: 'OpenAILLMService',

  implements: [ 'foam.ai.llm.LLMService' ],

  documentation: 'OpenAI implementation of LLMService. Server-side only (Java).',

  javaImports: [
    'foam.core.auth.APIKeyCredential',
    'foam.dao.DAO',
    'foam.lang.X',
    'foam.ai.llm.*',
    'foam.util.SafetyUtil',
    'java.util.ArrayList',
    'java.util.List',
    'java.io.BufferedReader',
    'java.io.InputStreamReader',
    'java.io.OutputStream',
    'java.net.HttpURLConnection',
    'java.net.URL',
    'org.json.JSONArray',
    'org.json.JSONObject'
  ],

  properties: [
    {
      class: 'String',
      name: 'credentialId',
      value: 'foam/llm/openai'
    },
    {
      class: 'String',
      name: 'apiKey',
      javaFactory: `
        foam.core.auth.APIKeyCredential cred = (foam.core.auth.APIKeyCredential)
          ((foam.dao.DAO) getX().get("credentialDAO")).find(getCredentialId());
        if ( cred == null ) throw new RuntimeException("LLM credential not found: " + getCredentialId());
        return cred.getApiKeySecret(getX());
      `
    },
    {
      class: 'String',
      name: 'defaultModel',
      value: 'gpt-4o'
    },
    {
      class: 'String',
      name: 'baseURL',
      value: 'https://api.openai.com/v1/chat/completions'
    }
  ],

  methods: [
    {
      name: 'complete',
      javaCode: `
        ChatMessage msg = new ChatMessage();
        msg.setRole(ChatRole.USER);
        msg.setContent(request.getPrompt());
        LLMOptions options = request.getOptions();
        return doRequest(x, apiMessages(options.getSystemPrompt(), new ChatMessage[] { msg }), options);
      `
    },
    {
      name: 'chat',
      javaCode: `
        LLMOptions options = request.getOptions();
        return doRequest(x, apiMessages(options.getSystemPrompt(), request.getMessages()), options);
      `
    },
    {
      name: 'apiMessages',
      documentation: `
        The conversation in the chat-completions format: the system prompt as the first
        message; an assistant turn that called tools carries tool_calls, followed by one
        role "tool" message per call holding its result, before the next user text.
      `,
      type: 'Object',
      args: 'String systemPrompt, foam.ai.llm.ChatMessage[] messages',
      javaCode: `
        JSONArray out = new JSONArray();
        if ( ! SafetyUtil.isEmpty(systemPrompt) ) {
          JSONObject sys = new JSONObject();
          sys.put("role",    "system");
          sys.put("content", systemPrompt);
          out.put(sys);
        }
        LLMToolUse[] pending = null;
        for ( ChatMessage m : messages ) {
          if ( pending != null ) {
            toolResults(out, pending);
            pending = null;
          }
          JSONObject msg = new JSONObject();
          msg.put("role", m.getRole().getLabel());
          if ( m.getRole() == ChatRole.ASSISTANT && m.getToolUses().length > 0 ) {
            msg.put("content", SafetyUtil.isEmpty(m.getContent()) ? JSONObject.NULL : m.getContent());
            JSONArray calls = new JSONArray();
            for ( LLMToolUse u : m.getToolUses() ) {
              JSONObject fn = new JSONObject();
              fn.put("name",      u.getName());
              fn.put("arguments", SafetyUtil.isEmpty(u.getInputJson()) ? "{}" : u.getInputJson());
              JSONObject call = new JSONObject();
              call.put("id",       u.getId());
              call.put("type",     "function");
              call.put("function", fn);
              calls.put(call);
            }
            msg.put("tool_calls", calls);
            pending = m.getToolUses();
            out.put(msg);
            continue;
          }
          // a turn holding only tool results sends no empty user message
          if ( m.getRole() == ChatRole.USER && SafetyUtil.isEmpty(m.getContent()) && out.length() > 0
               && "tool".equals(out.getJSONObject(out.length() - 1).optString("role")) ) continue;
          msg.put("content", m.getContent());
          out.put(msg);
        }
        if ( pending != null ) toolResults(out, pending);
        return out;
      `
    },
    {
      name: 'toolResults',
      visibility: 'protected',
      args: 'Object out, foam.ai.llm.LLMToolUse[] uses',
      javaCode: `
        for ( LLMToolUse u : uses ) {
          JSONObject msg = new JSONObject();
          msg.put("role",         "tool");
          msg.put("tool_call_id", u.getId());
          msg.put("content",      u.getResult());
          ((JSONArray) out).put(msg);
        }
      `
    },
    {
      name: 'requestBody',
      documentation: `
        The JSON body sent to the chat-completions endpoint, built without any network call
        so a test can read it. Web search and thinking have no chat-completions form and are
        left out.
      `,
      type: 'Object',
      args: 'Object messages, foam.ai.llm.LLMOptions options',
      javaCode: `
        String model = options.getModel();
        if ( model == null || model.isEmpty() ) model = getDefaultModel();
        int maxTokens = options.getMaxTokens() > 0 ? options.getMaxTokens() : 4096;

        JSONObject body = new JSONObject();
        body.put("model",      model);
        body.put("max_tokens", maxTokens);
        body.put("messages",   (JSONArray) messages);

        if ( options.getTemperature() > 0 ) {
          body.put("temperature", options.getTemperature());
        }

        if ( options.getTools().length > 0 ) {
          JSONArray tools = new JSONArray();
          for ( LLMTool t : options.getTools() ) {
            JSONObject fn = new JSONObject();
            fn.put("name",        t.getName());
            fn.put("description", t.getDescription());
            fn.put("parameters",  SafetyUtil.isEmpty(t.getInputSchema())
              ? new JSONObject().put("type", "object").put("properties", new JSONObject())
              : new JSONObject(t.getInputSchema()));
            JSONObject tool = new JSONObject();
            tool.put("type",     "function");
            tool.put("function", fn);
            tools.put(tool);
          }
          body.put("tools", tools);
        }
        return body;
      `
    },
    {
      name: 'parseReply',
      documentation: `
        The response read from a chat-completions reply. tool_calls become LLMToolUses and
        the stop reason reads tool_use, as from every provider; cached prompt tokens are
        counted once, as cache reads, not again as input.
      `,
      type: 'foam.ai.llm.LLMResponse',
      args: 'Object reply',
      javaCode: `
        JSONObject data    = (JSONObject) reply;
        JSONArray  choices = data.optJSONArray("choices");
        JSONObject choice  = choices != null && choices.length() > 0 ? choices.getJSONObject(0) : null;
        JSONObject message = choice == null ? null : choice.optJSONObject("message");

        List<LLMToolUse> uses  = new ArrayList<>();
        JSONArray        calls = message == null ? null : message.optJSONArray("tool_calls");
        for ( int i = 0 ; calls != null && i < calls.length() ; i++ ) {
          JSONObject call = calls.getJSONObject(i);
          JSONObject fn   = call.optJSONObject("function");
          LLMToolUse u    = new LLMToolUse();
          u.setId(call.optString("id", ""));
          u.setName(fn == null ? "" : fn.optString("name", ""));
          u.setInputJson(fn == null ? "{}" : fn.optString("arguments", "{}"));
          uses.add(u);
        }

        LLMResponse response = new LLMResponse();
        response.setContent(message == null || message.isNull("content") ? "" : message.optString("content", ""));
        response.setToolUses(uses.toArray(new LLMToolUse[0]));
        response.setModel(data.optString("model", ""));
        response.setStopReason(uses.size() > 0 ? "tool_use" : choice != null ? choice.optString("finish_reason", "") : "");

        JSONObject usage = data.optJSONObject("usage");
        if ( usage != null ) {
          JSONObject details = usage.optJSONObject("prompt_tokens_details");
          int cached = details == null ? 0 : details.optInt("cached_tokens", 0);
          response.setInputTokens(usage.optInt("prompt_tokens", 0) - cached);
          response.setCacheReadTokens(cached);
          response.setOutputTokens(usage.optInt("completion_tokens", 0));
        }
        return response;
      `
    },
    {
      name: 'doRequest',
      visibility: 'protected',
      type: 'foam.ai.llm.LLMResponse',
      args: 'Context x, Object messages, LLMOptions options',
      javaCode: `
        JSONObject body = (JSONObject) requestBody(messages, options);

        HttpURLConnection conn = null;
        try {
          URL url = new URL(getBaseURL());
          conn = (HttpURLConnection) url.openConnection();
          conn.setRequestMethod("POST");
          conn.setRequestProperty("Content-Type",  "application/json");
          conn.setRequestProperty("Authorization", "Bearer " + getApiKey());
          conn.setDoOutput(true);

          try ( OutputStream os = conn.getOutputStream() ) {
            os.write(body.toString().getBytes("UTF-8"));
          }

          int status = conn.getResponseCode();
          if ( status != 200 ) {
            BufferedReader err = new BufferedReader(
              new InputStreamReader(conn.getErrorStream(), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ( ( line = err.readLine() ) != null ) sb.append(line);
            err.close();
            throw new RuntimeException(
              "OpenAI API error (" + status + "): " + sb.toString());
          }

          BufferedReader reader = new BufferedReader(
            new InputStreamReader(conn.getInputStream(), "UTF-8"));
          StringBuilder sb = new StringBuilder();
          String line;
          while ( ( line = reader.readLine() ) != null ) sb.append(line);
          reader.close();

          return parseReply(new JSONObject(sb.toString()));
        } catch ( RuntimeException e ) {
          throw e;
        } catch ( Exception e ) {
          throw new RuntimeException("OpenAI API request failed: " + e.getMessage(), e);
        } finally {
          if ( conn != null ) conn.disconnect();
        }
      `
    }
  ]
});
