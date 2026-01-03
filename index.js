
import { saveSettingsDebounced, loadSettings, getContext } from "../../../extensions.js";
import { getChatId, saveChatDebounced } from "../../../chat-storage.js";
import { extension_settings, chat_metadata } from "../../../global.js";
import { POPUP_TYPE, popup } from "../../../popup.js";
import { generateQuietly } from "../../../script.js"; // Helper if available, otherwise we use fetch directly

// Default Settings
const DEFAULT_SETTINGS = {
    apiUrl: "https://api.openai.com",
    apiKey: "",
    model: "gpt-3.5-turbo",
    updateInterval: 5, // Every 5 messages
    systemPrompt: `你是一个专业的剧情记录员。请阅读以下聊天记录，并以严格的JSON格式输出以下内容：
1. "summary": 当前剧情的简要总结（100字以内）。
2. "characters": 一个列表，包含所有出现的角色，格式为 {"name": "名字", "status": "当前状态/心情/位置"}。
3. "items": 一个列表，包含所有重要物品，格式为 {"name": "物品名", "status": "状态/位置/持有者"}。

只输出JSON，不要包含markdown代码块或其他文字。`
};

const PLUGIN_NAME = "story_tracker";
let panel = null;
let isGenerating = false;
let messageCount = 0;

// Load Settings
async function loadPluginSettings() {
    if (!extension_settings[PLUGIN_NAME]) {
        extension_settings[PLUGIN_NAME] = { ...DEFAULT_SETTINGS };
    }
}

// UI Construction
function createPanel() {
    if ($('#story-tracker-panel').length) return;

    const panelHtml = `
    <div id="story-tracker-panel" class="minimized">
        <div class="st-minimized-icon" title="点击展开剧情追踪">📖</div>
        
        <div class="st-panel-header">
            <span class="st-panel-title">剧情追踪</span>
            <div class="st-panel-controls">
                <button id="st-refresh-btn" title="重新梳理">↻</button>
                <button id="st-settings-btn" title="设置">⚙️</button>
                <button id="st-minimize-btn" title="折叠">_</button>
            </div>
        </div>

        <div class="st-panel-content">
            <div class="st-section">
                <h4>剧情摘要 (Summary)</h4>
                <textarea id="st-summary-text" class="st-editable-text" placeholder="暂无摘要..."></textarea>
            </div>
            
            <div class="st-section">
                <h4>角色状态 (Characters)</h4>
                <div id="st-characters-list"></div>
                <button class="st-btn" id="st-add-char" style="margin-top:5px; font-size:10px;">+ 添加角色</button>
            </div>

            <div class="st-section">
                <h4>物品状态 (Items)</h4>
                <div id="st-items-list"></div>
                <button class="st-btn" id="st-add-item" style="margin-top:5px; font-size:10px;">+ 添加物品</button>
            </div>
        </div>
    </div>
    `;

    $('body').append(panelHtml);
    panel = $('#story-tracker-panel');

    // Event Listeners for Panel
    $('#st-minimize-btn, .st-minimized-icon').on('click', togglePanel);
    $('#st-refresh-btn').on('click', () => manualTrigger());
    $('#st-settings-btn').on('click', openSettingsPopup);
    $('#st-add-char').on('click', () => addEntityRow('st-characters-list'));
    $('#st-add-item').on('click', () => addEntityRow('st-items-list'));

    // Dragging Logic (Simple implementation)
    // ... (omitted for brevity, can add standard draggable if needed)

    // Bind inputs to save data
    $(document).on('input', '.st-editable-text, .st-list-input', saveToMetadata);
}

function togglePanel() {
    panel.toggleClass('minimized');
}

function addEntityRow(containerId, data = { name: "", status: "" }) {
    const row = `
    <div class="st-list-item">
        <input type="text" class="st-list-input name" placeholder="名称" value="${data.name}">
        <input type="text" class="st-list-input status" placeholder="状态" value="${data.status}">
    </div>
    `;
    $(`#${containerId}`).append(row);
}

function renderData() {
    const data = chat_metadata[PLUGIN_NAME] || {};

    $('#st-summary-text').val(data.summary || "");

    $('#st-characters-list').empty();
    if (data.characters && Array.isArray(data.characters)) {
        data.characters.forEach(c => addEntityRow('st-characters-list', c));
    }

    $('#st-items-list').empty();
    if (data.items && Array.isArray(data.items)) {
        data.items.forEach(i => addEntityRow('st-items-list', i));
    }
}

function saveToMetadata() {
    if (!getChatId()) return;

    const summary = $('#st-summary-text').val();
    const characters = [];
    $('#st-characters-list .st-list-item').each(function () {
        characters.push({
            name: $(this).find('.name').val(),
            status: $(this).find('.status').val()
        });
    });

    const items = [];
    $('#st-items-list .st-list-item').each(function () {
        items.push({
            name: $(this).find('.name').val(),
            status: $(this).find('.status').val()
        });
    });

    chat_metadata[PLUGIN_NAME] = { summary, characters, items };
    saveChatDebounced();
}

// Logic: API Call
async function manualTrigger() {
    if (isGenerating) return;
    const confirm = await popup.confirm("确认重新梳理剧情？这将消耗 API 额度。", "重新梳理");
    if (!confirm) return;
    await performSummarization();
}

async function performSummarization() {
    isGenerating = true;
    $('#st-refresh-btn').prop('disabled', true).text('...');

    try {
        const settings = extension_settings[PLUGIN_NAME];
        if (!settings.apiKey) throw new Error("请先在设置中配置 API Key");

        // Get Context (Last 20 messages for context, or tailored)
        const context = SillyTavern.getContext().chat.slice(-20); // Accessing global context in ST usually
        // Note: SillyTavern usually exposes context via various methods. 
        // For simplicity, we assume we can get the chat array. 
        // If not directly accessible, we might need `Tavern.chat`.
        // Let's assume `SillyTavern.getContext().chat` or `Tavern.chat` is available.
        // Fallback to reading DOM if necessary, but accessing array is better.

        let chatText = "";
        // Mock access - in real ST, iterate `SillyTavern.chathistory`
        if (typeof SillyTavern !== 'undefined' && SillyTavern.chathistory) {
            chatText = SillyTavern.chathistory.slice(-20).map(msg => `${msg.name}: ${msg.mes}`).join("\n");
        } else {
            // Fallback for mock environment or older ST
            chatText = "Unable to fetch history directly.";
        }

        const prompt = `${settings.systemPrompt}\n\n聊天记录:\n${chatText}`;

        const response = await fetch(`${settings.apiUrl.replace(/\/$/, '')}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify({
                model: settings.model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.5
            })
        });

        if (!response.ok) throw new Error(`API Error: ${response.statusText}`);

        const data = await response.json();
        const content = data.choices[0].message.content;

        // Parse JSON
        let parsed;
        try {
            // Try to find JSON block if wrapped in markdown
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
        } catch (e) {
            console.error("Failed to parse JSON", content);
            throw new Error("模型返回格式错误，无法解析为 JSON");
        }

        // Update UI & Metadata
        chat_metadata[PLUGIN_NAME] = parsed;
        saveChatDebounced();
        renderData();
        toastr.success("剧情梳理完成");

    } catch (err) {
        toastr.error(err.message, "梳理失败");
        console.error(err);
    } finally {
        isGenerating = false;
        $('#st-refresh-btn').prop('disabled', false).text('↻');
    }
}

// Logic: Message Listener
function onMessageReceived() {
    messageCount++;
    const settings = extension_settings[PLUGIN_NAME];
    if (settings.updateInterval > 0 && messageCount >= settings.updateInterval) {
        messageCount = 0;
        performSummarization(); // Auto-trigger
    }
}

// Settings Popup
async function openSettingsPopup() {
    const settings = extension_settings[PLUGIN_NAME];

    const html = `
    <div class="st-settings-container">
        <div class="st-settings-row">
            <label>API URL (Custom URL)</label>
            <input type="text" id="st-api-url" value="${settings.apiUrl}" placeholder="https://api.openai.com">
        </div>
        <div class="st-settings-row">
            <label>API Key</label>
            <input type="password" id="st-api-key" value="${settings.apiKey}" placeholder="sk-...">
        </div>
        
        <div class="st-settings-row">
            <label>模型 (Model)</label>
            <div class="st-flex-row">
                <select id="st-model-select" style="flex:1">
                    <option value="${settings.model}">${settings.model}</option>
                </select>
                <button id="st-fetch-models" class="st-btn">获取模型</button>
            </div>
        </div>

        <div class="st-settings-row">
            <label>自动更新频率 (消息数, 0为关闭)</label>
            <input type="number" id="st-interval" value="${settings.updateInterval}">
        </div>

        <div class="st-settings-row">
            <label>系统提示词 (System Prompt)</label>
            <textarea id="st-prompt" class="st-editable-text" rows="6">${settings.systemPrompt}</textarea>
        </div>
    </div>
    `;

    const result = await popup.confirm(html, "剧情追踪设置");
    if (result) {
        // Save
        settings.apiUrl = $('#st-api-url').val();
        settings.apiKey = $('#st-api-key').val();
        settings.model = $('#st-model-select').val();
        settings.updateInterval = parseInt($('#st-interval').val());
        settings.systemPrompt = $('#st-prompt').val();
        extension_settings[PLUGIN_NAME] = settings;
        saveSettingsDebounced();
    }
}

// Wire up "Fetch Models" logic inside the popup
$(document).on('click', '#st-fetch-models', async function () {
    const url = $('#st-api-url').val();
    const key = $('#st-api-key').val();
    const btn = $(this);

    if (!url || !key) {
        toastr.warning("请先填写 URL 和 API Key");
        return;
    }

    btn.prop('disabled', true).text('...');
    try {
        const res = await fetch(`${url.replace(/\/$/, '')}/v1/models`, {
            headers: { 'Authorization': `Bearer ${key}` }
        });
        const data = await res.json();
        const select = $('#st-model-select');
        select.empty();
        data.data.forEach(m => {
            select.append(`<option value="${m.id}">${m.id}</option>`);
        });
        toastr.success("模型列表已更新");
    } catch (e) {
        toastr.error("获取模型失败: " + e.message);
    } finally {
        btn.prop('disabled', false).text('获取模型');
    }
});


// Initialization
jQuery(async () => {
    // Load style
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/scripts/extensions/story_tracker/style.css'; // Assuming standard path mapping
    document.head.appendChild(link);

    await loadPluginSettings();
    createPanel();

    // Hook into ST events
    if (window.eventSource) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.CHAT_CHANGED, renderData);
    }

    // Initial Render
    renderData();
});
