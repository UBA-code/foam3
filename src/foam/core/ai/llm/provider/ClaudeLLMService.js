/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

foam.CLASS({
  package: 'foam.core.ai.llm.provider',
  name: 'ClaudeLLMService',

  implements: [ 'foam.ai.llm.LLMService' ],

  documentation: `
    Anthropic Claude implementation of LLMService.
    API key is injected via CSpec config — never exposed to client.
    Server-side only (Java).
  `,

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
      value: 'foam/llm/claude'
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
      value: 'claude-sonnet-4-20250514'
    },
    {
      class: 'String',
      name: 'baseURL',
      value: 'https://api.anthropic.com/v1/messages'
    },
    {
      class: 'String',
      name: 'apiVersion',
      value: '2023-06-01'
    }
  ],

  methods: [
    {
      name: 'complete',
      javaCode: `
        JSONArray messages = new JSONArray();
        JSONObject msg = new JSONObject();
        msg.put("role", "user");
        msg.put("content", request.getPrompt());
        messages.put(msg);

        return doRequest(x, messages, request.getOptions());
      `
    },
    {
      name: 'chat',
      javaCode: `
        return doRequest(x, apiMessages(request.getMessages()), request.getOptions());
      `
    },
    {
      name: 'apiMessages',
      documentation: `
        The conversation in Anthropic's format. An assistant turn that called tools carries
        one tool_use block per call, and the user turn after it opens with one tool_result
        block per call, since the model reads a call's result before the next user text.
        When the conversation ends on such an assistant turn, a user turn holding only the
        results is added.
      `,
      type: 'Object',
      args: 'foam.ai.llm.ChatMessage[] messages',
      javaCode: `
        JSONArray     out     = new JSONArray();
        LLMToolUse[]  pending = null;
        for ( ChatMessage m : messages ) {
          JSONObject msg = new JSONObject();
          msg.put("role", m.getRole().getLabel());
          if ( m.getRole() == ChatRole.ASSISTANT && m.getToolUses().length > 0 ) {
            JSONArray blocks = new JSONArray();
            if ( ! SafetyUtil.isEmpty(m.getContent()) ) blocks.put(textBlock(m.getContent()));
            for ( LLMToolUse u : m.getToolUses() ) {
              JSONObject b = new JSONObject();
              b.put("type",  "tool_use");
              b.put("id",    u.getId());
              b.put("name",  u.getName());
              b.put("input", SafetyUtil.isEmpty(u.getInputJson()) ? new JSONObject() : new JSONObject(u.getInputJson()));
              blocks.put(b);
            }
            msg.put("content", blocks);
            pending = m.getToolUses();
          } else if ( pending != null ) {
            JSONArray blocks = (JSONArray) toolResults(pending);
            if ( ! SafetyUtil.isEmpty(m.getContent()) ) blocks.put(textBlock(m.getContent()));
            msg.put("content", blocks);
            pending = null;
          } else {
            msg.put("content", m.getContent());
          }
          out.put(msg);
        }
        if ( pending != null ) {
          JSONObject msg = new JSONObject();
          msg.put("role",    "user");
          msg.put("content", toolResults(pending));
          out.put(msg);
        }
        return out;
      `
    },
    {
      name: 'toolResults',
      visibility: 'protected',
      type: 'Object',
      args: 'foam.ai.llm.LLMToolUse[] uses',
      javaCode: `
        JSONArray blocks = new JSONArray();
        for ( LLMToolUse u : uses ) {
          JSONObject b = new JSONObject();
          b.put("type",        "tool_result");
          b.put("tool_use_id", u.getId());
          b.put("content",     u.getResult());
          blocks.put(b);
        }
        return blocks;
      `
    },
    {
      name: 'textBlock',
      visibility: 'protected',
      type: 'Object',
      args: 'String text',
      javaCode: `
        JSONObject b = new JSONObject();
        b.put("type", "text");
        b.put("text", text);
        return b;
      `
    },
    {
      name: 'requestBody',
      documentation: 'The JSON body sent to the Messages API, built without any network call so a test can read it.',
      type: 'Object',
      args: 'Object messages, foam.ai.llm.LLMOptions options',
      javaCode: `
        String model     = options.getModel();
        if ( model == null || model.isEmpty() ) model = getDefaultModel();
        int    maxTokens = options.getMaxTokens() > 0 ? options.getMaxTokens() : 4096*2;

        JSONObject body = new JSONObject();
        body.put("model",      model);
        body.put("max_tokens", maxTokens);
        body.put("messages",   (JSONArray) messages);

        if ( options.getTemperature() > 0 ) {
          body.put("temperature", options.getTemperature());
        }

        String systemPrompt = options.getSystemPrompt();
        if ( systemPrompt != null && ! systemPrompt.isEmpty() ) {
          body.put("system", systemPrompt);
        }

        JSONArray tools = new JSONArray();
        for ( LLMTool t : options.getTools() ) {
          JSONObject tool = new JSONObject();
          tool.put("name",        t.getName());
          tool.put("description", t.getDescription());
          tool.put("input_schema", SafetyUtil.isEmpty(t.getInputSchema())
            ? new JSONObject().put("type", "object").put("properties", new JSONObject())
            : new JSONObject(t.getInputSchema()));
          tools.put(tool);
        }
        if ( options.getWebSearch() ) {
          JSONObject search = new JSONObject();
          search.put("type",     "web_search_20260209");
          search.put("name",     "web_search");
          search.put("max_uses", 5);
          tools.put(search);
        }
        if ( tools.length() > 0 ) body.put("tools", tools);

        if ( options.getThinking() == LLMThinking.DISABLED ) {
          body.put("thinking", new JSONObject().put("type", "disabled"));
        } else if ( options.getThinking() == LLMThinking.BETWEEN_TOOLS ) {
          body.put("thinking", new JSONObject().put("type", "between_tools"));
        }

        return body;
      `
    },
    {
      name: 'parseReply',
      documentation: 'The response read from the Messages API reply: text blocks joined, tool_use blocks as LLMToolUses, usage.',
      type: 'foam.ai.llm.LLMResponse',
      args: 'Object reply',
      javaCode: `
        JSONObject data    = (JSONObject) reply;
        JSONArray  content = data.getJSONArray("content");
        StringBuilder      text = new StringBuilder();
        List<LLMToolUse>   uses = new ArrayList<>();
        for ( int i = 0 ; i < content.length() ; i++ ) {
          JSONObject block = content.getJSONObject(i);
          String     type  = block.getString("type");
          if ( "text".equals(type) ) {
            if ( text.length() > 0 ) text.append("\\n");
            text.append(block.getString("text"));
          } else if ( "tool_use".equals(type) ) {
            LLMToolUse u = new LLMToolUse();
            u.setId(block.getString("id"));
            u.setName(block.getString("name"));
            JSONObject input = block.optJSONObject("input");
            u.setInputJson(input == null ? "{}" : input.toString());
            uses.add(u);
          }
        }

        LLMResponse response = new LLMResponse();
        response.setContent(text.toString());
        response.setToolUses(uses.toArray(new LLMToolUse[0]));
        response.setModel(data.optString("model", ""));
        response.setStopReason(data.optString("stop_reason", ""));

        JSONObject usage = data.optJSONObject("usage");
        if ( usage != null ) {
          response.setInputTokens(usage.optInt("input_tokens", 0));
          response.setOutputTokens(usage.optInt("output_tokens", 0));
          response.setCacheReadTokens(usage.optInt("cache_read_input_tokens", 0));
          response.setCacheWriteTokens(usage.optInt("cache_creation_input_tokens", 0));
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

        // HTTP request
        HttpURLConnection conn = null;
        try {
          URL url = new URL(getBaseURL());
          conn = (HttpURLConnection) url.openConnection();
          conn.setRequestMethod("POST");
          conn.setRequestProperty("Content-Type",      "application/json");
          conn.setRequestProperty("x-api-key",         getApiKey());
          conn.setRequestProperty("anthropic-version",  getApiVersion());
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
              "Claude API error (" + status + "): " + sb.toString());
          }

          // Read response
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
          throw new RuntimeException("Claude API request failed: " + e.getMessage(), e);
        } finally {
          if ( conn != null ) conn.disconnect();
        }
      `
    }
  ]
});
