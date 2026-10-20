export const INITIAL_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS users (
        uid TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        balance REAL DEFAULT 0,
        phone TEXT DEFAULT '',
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        agentId TEXT,
        module TEXT,
        message TEXT NOT NULL,
        response TEXT,
        role TEXT DEFAULT '',
        personality TEXT DEFAULT '',
        mode TEXT DEFAULT '',
        toolCalls TEXT DEFAULT '',
        conversationId TEXT DEFAULT '',
        cognitiveIntent TEXT DEFAULT '',
        llmWasCalled INTEGER DEFAULT 0,
        completionFeedback TEXT DEFAULT '',
        domain TEXT DEFAULT 'personal',
        orgId TEXT DEFAULT '',
        source TEXT DEFAULT '',
        channel TEXT DEFAULT '',
        externalMessageId TEXT DEFAULT '',
        routeSequence INTEGER,
        receivedAt TEXT DEFAULT '',
        requestId TEXT DEFAULT '',
        nativeDeviceId TEXT DEFAULT '',
        executionSessionId TEXT DEFAULT '',
        nativeClientIdentitySha256 TEXT DEFAULT '',
        audioInputKind TEXT DEFAULT '',
        syntheticAudio INTEGER,
        captureSessionId TEXT DEFAULT '',
        sttReceiptId TEXT DEFAULT '',
        contextChainId TEXT DEFAULT '',
        previousRequestId TEXT DEFAULT '',
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS marketplace_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        author TEXT NOT NULL,
        price REAL NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS founder_vision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS avatar_live_turns (
        userId TEXT NOT NULL,
        avatarId TEXT NOT NULL,
        requestId TEXT NOT NULL,
        nickname TEXT NOT NULL,
        comment TEXT NOT NULL,
        reply TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        spokenAt TEXT,
        PRIMARY KEY (userId, avatarId, requestId)
      );
      CREATE INDEX IF NOT EXISTS idx_avatar_live_history
        ON avatar_live_turns(userId, avatarId, createdAt DESC);

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        agentId TEXT,
        title TEXT DEFAULT '',
        status TEXT DEFAULT 'active',
        surface TEXT NOT NULL DEFAULT 'chat',
        summary TEXT DEFAULT '',
        summaryChain TEXT DEFAULT '[]',
        lastSummaryMessageCount INTEGER DEFAULT -1,
        actionContinuationState TEXT DEFAULT '{}',
        messageCount INTEGER DEFAULT 0,
        lastActiveAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        domain TEXT DEFAULT 'personal',
        orgId TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS conversation_action_tasks (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        userId TEXT NOT NULL,
        domain TEXT DEFAULT 'personal',
        orgId TEXT DEFAULT '',
        parentTaskId TEXT DEFAULT '',
        rootUserMessageId TEXT DEFAULT '',
        intentKind TEXT NOT NULL DEFAULT 'none',
        operation TEXT NOT NULL DEFAULT 'read',
        goal TEXT NOT NULL,
        target TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planning',
        blocker TEXT DEFAULT '',
        activeRequestId TEXT DEFAULT '',
        completionSource TEXT DEFAULT '',
        context TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        completedAt TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS conversation_action_turns (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        userId TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'personal',
        orgId TEXT NOT NULL DEFAULT '',
        requestId TEXT NOT NULL,
        userMessageId TEXT NOT NULL,
        taskId TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'accepted',
        leaseOwnerId TEXT NOT NULL DEFAULT '',
        leaseEpoch TEXT NOT NULL DEFAULT '',
        leaseAcquiredAt TEXT NOT NULL DEFAULT '',
        leaseHeartbeatAt TEXT NOT NULL DEFAULT '',
        leaseExpiresAt TEXT NOT NULL DEFAULT '',
        terminalMessageId TEXT NOT NULL DEFAULT '',
        terminalReason TEXT NOT NULL DEFAULT '',
        recoveryReason TEXT NOT NULL DEFAULT '',
        recoveredAt TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        terminalAt TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS conversation_action_receipts (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        conversationId TEXT NOT NULL,
        turnId TEXT DEFAULT '',
        requestId TEXT DEFAULT '',
        turnRowId TEXT NOT NULL DEFAULT '',
        externalMessageId TEXT NOT NULL DEFAULT '',
        modelRoutingReceiptId TEXT NOT NULL DEFAULT '',
        executionOrigin TEXT NOT NULL DEFAULT '',
        idempotencyKey TEXT NOT NULL,
        toolName TEXT NOT NULL,
        targetIdentity TEXT DEFAULT '',
        inputDigest TEXT DEFAULT '',
        envelope TEXT NOT NULL DEFAULT '{}',
        outcome TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_routing_receipts (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'personal',
        orgId TEXT NOT NULL DEFAULT '',
        conversationId TEXT NOT NULL DEFAULT '',
        requestId TEXT NOT NULL DEFAULT '',
        nativeDeviceId TEXT NOT NULL DEFAULT '',
        executionSessionId TEXT NOT NULL DEFAULT '',
        nativeClientIdentitySha256 TEXT NOT NULL DEFAULT '',
        audioInputKind TEXT NOT NULL DEFAULT '',
        syntheticAudio INTEGER,
        captureSessionId TEXT NOT NULL DEFAULT '',
        sttReceiptId TEXT NOT NULL DEFAULT '',
        contextChainId TEXT NOT NULL DEFAULT '',
        previousRequestId TEXT NOT NULL DEFAULT '',
        interactionId TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        requestedProvider TEXT NOT NULL,
        requestedModel TEXT NOT NULL,
        selectionMode TEXT NOT NULL,
        selectedProvider TEXT NOT NULL DEFAULT '',
        selectedModel TEXT NOT NULL DEFAULT '',
        fallbackReason TEXT NOT NULL DEFAULT '',
        attempts TEXT NOT NULL DEFAULT '[]',
        startedAt TEXT NOT NULL,
        completedAt TEXT NOT NULL,
        durationMs INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS chat_execution_terminal_receipts (
        userId TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'personal',
        orgId TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'chat',
        conversationId TEXT NOT NULL DEFAULT '',
        requestId TEXT NOT NULL,
        status TEXT NOT NULL,
        event TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        PRIMARY KEY (userId, domain, orgId, source, conversationId, requestId)
      );

      CREATE TABLE IF NOT EXISTS read_only_tool_patterns (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'personal',
        orgId TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0,
        successCount INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS command_center_plans (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'personal',
        orgId TEXT NOT NULL DEFAULT '',
        conversationId TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        cadence TEXT NOT NULL DEFAULT 'none',
        timeOfDay TEXT NOT NULL DEFAULT '09:00',
        dayOfWeek INTEGER NOT NULL DEFAULT 1,
        dayOfMonth INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        nextRunAt TEXT NOT NULL DEFAULT '',
        lastRunAt TEXT NOT NULL DEFAULT '',
        lastRuntimeTaskId TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        membershipAuthorization TEXT NOT NULL DEFAULT '',
        authorizationBlockedReason TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS autonomous_tasks (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        status TEXT NOT NULL,
        leaseExpiresAt TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS external_commit_journal (
        idempotencyKey TEXT PRIMARY KEY,
        taskId TEXT DEFAULT '',
        userId TEXT DEFAULT '',
        toolName TEXT NOT NULL,
        inputDigest TEXT NOT NULL,
        state TEXT NOT NULL,
        replayResult TEXT NOT NULL DEFAULT '',
        claimToken TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS external_ai_history_sources (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'personal',
        orgId TEXT NOT NULL DEFAULT '',
        sourceKind TEXT NOT NULL,
        status TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS external_ai_history_sync_jobs (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        userId TEXT NOT NULL,
        status TEXT NOT NULL,
        nextCursor TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS external_ai_history_conversations (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        userId TEXT NOT NULL,
        externalConversationId TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        UNIQUE(sourceId, externalConversationId)
      );

      CREATE TABLE IF NOT EXISTS external_ai_history_messages (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        conversationId TEXT NOT NULL,
        userId TEXT NOT NULL,
        externalMessageId TEXT NOT NULL,
        contentDigest TEXT NOT NULL,
        messageAt TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        UNIQUE(sourceId, externalMessageId)
      );

      CREATE TABLE IF NOT EXISTS external_ai_history_attachments (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        userId TEXT NOT NULL,
        externalAttachmentId TEXT NOT NULL,
        contentDigest TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        UNIQUE(sourceId, externalAttachmentId)
      );

      CREATE TABLE IF NOT EXISTS extension_publishers (
        fingerprint TEXT PRIMARY KEY,
        publisherId TEXT NOT NULL,
        status TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS extension_revisions (
        id TEXT PRIMARY KEY,
        extensionId TEXT NOT NULL,
        userId TEXT NOT NULL,
        version TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        manifestDigest TEXT NOT NULL,
        signerFingerprint TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        UNIQUE(extensionId, version)
      );

      CREATE TABLE IF NOT EXISTS extension_activation_receipts (
        id TEXT PRIMARY KEY,
        extensionId TEXT NOT NULL,
        revisionId TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS external_capability_packages (
        id TEXT PRIMARY KEY,
        ownerUserId TEXT NOT NULL,
        capabilityId TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        packageDigest TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS external_capability_receipts (
        id TEXT PRIMARY KEY,
        packageRowId TEXT NOT NULL,
        ownerUserId TEXT NOT NULL,
        capabilityId TEXT NOT NULL,
        actionId TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS voice_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL,
        voiceId TEXT NOT NULL,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS token_usage (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        promptTokens INTEGER NOT NULL,
        completionTokens INTEGER NOT NULL,
        totalTokens INTEGER NOT NULL,
        mode TEXT DEFAULT 'chat',
        interactionId TEXT DEFAULT '',
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        ownerUid TEXT NOT NULL,
        settings TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS departments (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        name TEXT NOT NULL,
        parentId TEXT,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_memberships (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        userId TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        departmentId TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        invitedBy TEXT,
        joinedAt TEXT,
        createdAt TEXT NOT NULL,
        UNIQUE(orgId, userId)
      );

      CREATE TABLE IF NOT EXISTS org_positions (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        departmentId TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_work_routing_rules (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_work_items (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        idempotencyKey TEXT NOT NULL,
        requestId TEXT NOT NULL,
        source TEXT NOT NULL,
        requesterUserId TEXT NOT NULL,
        conversationId TEXT NOT NULL DEFAULT '',
        taskId TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(orgId, idempotencyKey)
      );

      CREATE TABLE IF NOT EXISTS org_work_approvals (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        workItemId TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_work_handoffs (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        workItemId TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_resource_policies (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        classification TEXT NOT NULL DEFAULT 'organization',
        status TEXT NOT NULL DEFAULT 'active',
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(orgId, resourceType, resourceId)
      );

      CREATE TABLE IF NOT EXISTS org_resource_grants (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        subjectType TEXT NOT NULL,
        subjectId TEXT NOT NULL,
        effect TEXT NOT NULL DEFAULT 'allow',
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_credential_references (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_devices (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        branchId TEXT NOT NULL UNIQUE,
        userId TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_invitations (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL,
        createdBy TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        departmentId TEXT,
        maxUses INTEGER DEFAULT 0,
        useCount INTEGER DEFAULT 0,
        expiresAt TEXT,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_kb_articles (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        tags TEXT DEFAULT '[]',
        authorId TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'published',
        viewCount INTEGER DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        ingestionManifest TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS org_kb_embeddings (
        id TEXT PRIMARY KEY,
        articleId TEXT NOT NULL,
        chunkIndex INTEGER NOT NULL,
        embedding TEXT NOT NULL,
        content TEXT NOT NULL,
        modelName TEXT NOT NULL DEFAULT 'text-embedding-3-small',
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        read INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        userId TEXT NOT NULL,
        action TEXT NOT NULL,
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        details TEXT DEFAULT '{}',
        ipAddress TEXT,
        userAgent TEXT,
        timestamp TEXT NOT NULL
      );
    `;
