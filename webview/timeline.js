// @ts-check

/**
 * Timeline webview client-side logic.
 * Communicates with the extension via postMessage.
 */
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ── DOM references ─────────────────────────────────────────────────────
  const headerTitle = document.getElementById('headerTitle');
  const headerSubtitle = document.getElementById('headerSubtitle');
  const stepList = document.getElementById('stepList');
  const emptyState = document.getElementById('emptyState');
  const narrationText = document.getElementById('narrationText');
  const narrationPanel = document.getElementById('narrationPanel');
  const progressFill = document.getElementById('progressFill');
  const btnPrev = document.getElementById('btnPrev');
  const btnNext = document.getElementById('btnNext');
  const btnPlayPause = document.getElementById('btnPlayPause');
  const pregenStatus = document.getElementById('pregenStatus');
  const pregenFill = document.getElementById('pregenFill');
  const pregenText = document.getElementById('pregenText');
  const transitionBanner = document.getElementById('transitionBanner');
  const transitionText = document.getElementById('transitionText');
  const btnLoadReplay = document.getElementById('btnLoadReplay');
  const btnPickTrace = document.getElementById('btnPickTrace');
  const traceNotification = document.getElementById('traceNotification');
  const traceNotificationDetail = document.getElementById('traceNotificationDetail');
  const traceNotificationFilename = document.getElementById('traceNotificationFilename');
  const btnWalkthrough = document.getElementById('btnWalkthrough');
  const btnViewSummary = document.getElementById('btnViewSummary');
  const btnDismissNotification = document.getElementById('btnDismissNotification');

  // ── State ──────────────────────────────────────────────────────────────
  let currentIndex = -1;
  let events = [];
  let visitedSteps = new Set();
  let playState = 'stopped';
  let collapsedSections = new Set(); // set of sectionStart event IDs
  let pregenProgress = { current: 0, total: 0, status: 'idle' };
  let commentInputEventId = null; // which step's comment input is showing

  // ── Icons per event type ───────────────────────────────────────────────
  var TYPE_ICONS = {
    openFile: '\u{1F4C4}',       // page
    showDiff: '\u{1F504}',       // arrows
    highlightRange: '\u{1F4CD}', // pin
    say: '\u{1F4AC}',            // speech
    sectionStart: '\u{1F4C1}',   // folder
    sectionEnd: '',               // not rendered
  };

  // ── Risk icons ────────────────────────────────────────────────────────
  var RISK_ICONS = {
    'security': '\u{1F6E1}',       // shield
    'breaking-change': '\u26A0',   // warning
    'migration': '\u{1F4BE}',      // disk
    'performance': '\u26A1',       // lightning
  };

  // ── Section tree builder ───────────────────────────────────────────────

  /**
   * Build a tree structure from the flat events array.
   * Returns an array of nodes: { type: 'section'|'step', event, index, children? }
   */
  function buildSectionTree(eventList) {
    var items = [];
    var sectionStack = [];

    eventList.forEach(function (event, index) {
      if (event.type === 'sectionStart') {
        var section = {
          type: 'section',
          event: event,
          index: index,
          children: [],
        };
        if (sectionStack.length > 0) {
          sectionStack[sectionStack.length - 1].children.push(section);
        } else {
          items.push(section);
        }
        sectionStack.push(section);
      } else if (event.type === 'sectionEnd') {
        if (sectionStack.length > 0) {
          sectionStack.pop();
        }
      } else {
        var step = { type: 'step', event: event, index: index };
        if (sectionStack.length > 0) {
          sectionStack[sectionStack.length - 1].children.push(step);
        } else {
          items.push(step);
        }
      }
    });

    return items;
  }

  // ── Render helpers ─────────────────────────────────────────────────────

  function renderRiskBadges(risks) {
    if (!risks || risks.length === 0) return null;

    var container = document.createElement('span');
    container.className = 'step-risks';

    risks.forEach(function (risk) {
      var badge = document.createElement('span');
      badge.className = 'risk-badge ' + (risk.category || '').replace(/\s+/g, '-');
      var icon = RISK_ICONS[risk.category] || '\u26A0';
      badge.textContent = icon;
      badge.title = risk.label || risk.category;
      container.appendChild(badge);
    });

    return container;
  }

  function renderSectionHeader(node, indentLevel) {
    var isCollapsed = collapsedSections.has(node.event.id);
    var isCurrent = node.index === currentIndex;

    var wrapper = document.createElement('div');
    wrapper.className = 'section-group' + (isCollapsed ? ' section-collapsed' : '');

    var header = document.createElement('div');
    header.className = 'section-header' + (isCurrent ? ' current' : '');
    if (indentLevel > 0) {
      header.style.paddingLeft = (16 + indentLevel * 16) + 'px';
    }

    var arrow = document.createElement('span');
    arrow.className = 'section-arrow';
    arrow.textContent = '\u25BC'; // down triangle

    var title = document.createElement('span');
    title.className = 'section-title';
    title.textContent = node.event.title;

    var count = document.createElement('span');
    count.className = 'section-count';
    var childStepCount = countSteps(node.children);
    count.textContent = '(' + childStepCount + ' step' + (childStepCount !== 1 ? 's' : '') + ')';

    header.appendChild(arrow);
    header.appendChild(title);
    header.appendChild(count);

    header.addEventListener('click', function () {
      if (collapsedSections.has(node.event.id)) {
        collapsedSections.delete(node.event.id);
      } else {
        collapsedSections.add(node.event.id);
      }
      render();
    });

    wrapper.appendChild(header);

    var childrenDiv = document.createElement('div');
    childrenDiv.className = 'section-children';
    renderNodes(node.children, childrenDiv, indentLevel + 1);
    wrapper.appendChild(childrenDiv);

    return wrapper;
  }

  function renderStepItem(node, indentLevel) {
    var event = node.event;
    var index = node.index;

    var item = document.createElement('div');
    item.className = 'step-item';
    if (indentLevel > 0) item.classList.add('indented');
    if (index === currentIndex) item.classList.add('current');
    if (visitedSteps.has(index)) item.classList.add('visited');

    if (indentLevel > 1) {
      item.style.paddingLeft = (16 + indentLevel * 16) + 'px';
    }

    var num = document.createElement('span');
    num.className = 'step-number';
    num.textContent = String(index + 1);

    var icon = document.createElement('span');
    icon.className = 'step-icon';
    icon.textContent = TYPE_ICONS[event.type] || '\u2022';

    var title = document.createElement('span');
    title.className = 'step-title';
    title.textContent = event.title;

    // Comment button
    var commentBtn = document.createElement('button');
    commentBtn.className = 'comment-btn' + (event.comment ? ' has-comment' : '');
    commentBtn.innerHTML = '&#x1F4AC;'; // speech bubble emoji
    commentBtn.title = event.comment || 'Add comment';
    commentBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      commentInputEventId = (commentInputEventId === event.id) ? null : event.id;
      render();
    });

    item.appendChild(num);
    item.appendChild(icon);
    item.appendChild(title);

    // Risk badges (if any)
    var riskBadges = renderRiskBadges(event.risks);
    if (riskBadges) {
      item.appendChild(riskBadges);
    }

    item.appendChild(commentBtn);

    item.addEventListener('click', function () {
      vscode.postMessage({ command: 'goToStep', index: index });
    });

    return item;
  }

  function renderCommentInput(event, indentLevel) {
    var row = document.createElement('div');
    row.className = 'comment-input-row';
    if (indentLevel > 0) {
      row.style.paddingLeft = (16 + indentLevel * 16) + 'px';
    }

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'comment-input';
    input.placeholder = 'Add feedback for agent...';
    input.value = event.comment || '';

    var saveBtn = document.createElement('button');
    saveBtn.className = 'comment-submit';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', function () {
      vscode.postMessage({
        command: 'saveComment',
        eventId: event.id,
        comment: input.value
      });
      commentInputEventId = null;
      render();
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveBtn.click();
      if (e.key === 'Escape') {
        commentInputEventId = null;
        render();
      }
    });

    row.appendChild(input);
    row.appendChild(saveBtn);

    setTimeout(function () { input.focus(); }, 0);
    return row;
  }

  function renderNodes(nodes, container, indentLevel) {
    nodes.forEach(function (node) {
      var element;
      if (node.type === 'section') {
        element = renderSectionHeader(node, indentLevel);
      } else {
        element = renderStepItem(node, indentLevel);
      }
      if (element) {
        container.appendChild(element);
      }
      // Render comment input below step if active
      if (node.type === 'step' && commentInputEventId === node.event.id) {
        container.appendChild(renderCommentInput(node.event, indentLevel));
      }
    });
  }

  function countSteps(nodes) {
    var count = 0;
    nodes.forEach(function (node) {
      if (node.type === 'step') {
        count++;
      } else if (node.type === 'section' && node.children) {
        count += countSteps(node.children);
      }
    });
    return count;
  }

  // ── Update pre-generation progress ───────────────────────────────────

  function updatePregenProgress() {
    if (pregenProgress.status === 'complete' || pregenProgress.total === 0) {
      pregenStatus.style.display = 'none';
    } else {
      pregenStatus.style.display = 'block';
      var pct = (pregenProgress.current / pregenProgress.total) * 100;
      pregenFill.style.width = pct + '%';
      pregenText.textContent = 'Preparing audio (' + pregenProgress.current + '/' + pregenProgress.total + ')';
    }
  }

  // ── Main render ────────────────────────────────────────────────────────

  function render() {
    if (events.length === 0) {
      emptyState.style.display = 'block';
      narrationPanel.style.display = 'none';
      document.getElementById('controls').style.display = 'none';
      headerTitle.textContent = 'No replay loaded';
      headerSubtitle.textContent = '';
      progressFill.style.width = '0%';
      return;
    }

    emptyState.style.display = 'none';
    narrationPanel.style.display = 'block';
    document.getElementById('controls').style.display = 'flex';

    // Header
    var fileCount = new Set(events.filter(function (e) { return e.filePath; }).map(function (e) { return e.filePath; })).size;
    var commentCount = events.filter(function (e) { return e.comment; }).length;
    headerTitle.textContent = 'Replay Session';
    var subtitle = events.length + ' steps';
    if (fileCount > 0) subtitle += ' \u00B7 ' + fileCount + ' files';
    if (commentCount > 0) subtitle += ' \u00B7 ' + commentCount + ' comment' + (commentCount !== 1 ? 's' : '');
    headerSubtitle.textContent = subtitle;

    // Progress bar
    if (events.length > 0 && currentIndex >= 0) {
      var pct = ((currentIndex + 1) / events.length) * 100;
      progressFill.style.width = pct + '%';
    } else {
      progressFill.style.width = '0%';
    }

    // Step list — build tree and render
    stepList.innerHTML = '';
    var tree = buildSectionTree(events);

    renderNodes(tree, stepList, 0);

    // Scroll current step into view
    var currentItem = stepList.querySelector('.step-item.current, .section-header.current');
    if (currentItem) {
      currentItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    // Narration
    if (currentIndex >= 0 && currentIndex < events.length) {
      narrationText.textContent = events[currentIndex].narration || '';
    } else {
      narrationText.textContent = '';
    }

    // Navigation buttons
    btnPrev.disabled = currentIndex <= 0;
    btnNext.disabled = currentIndex >= events.length - 1;

    // Play/pause button
    updatePlayButton();
  }

  // ── Control updates ────────────────────────────────────────────────────

  function updatePlayButton() {
    if (playState === 'playing') {
      btnPlayPause.innerHTML = '&#10074;&#10074;'; // pause icon
      btnPlayPause.title = 'Pause (Space)';
    } else {
      btnPlayPause.innerHTML = '&#9654;'; // play icon
      btnPlayPause.title = 'Play (Space)';
    }
  }

  // ── Button handlers ────────────────────────────────────────────────────

  btnPrev.addEventListener('click', function () {
    vscode.postMessage({ command: 'previous' });
  });

  btnNext.addEventListener('click', function () {
    vscode.postMessage({ command: 'next' });
  });

  btnPlayPause.addEventListener('click', function () {
    vscode.postMessage({ command: 'togglePlayPause' });
  });

  btnLoadReplay.addEventListener('click', function () {
    vscode.postMessage({ command: 'loadReplay' });
  });

  btnPickTrace.addEventListener('click', function () {
    vscode.postMessage({ command: 'loadReplay' });
  });

  btnWalkthrough.addEventListener('click', function () {
    traceNotification.classList.remove('visible');
    vscode.postMessage({ command: 'notificationAction', action: 'walkthrough' });
  });

  btnViewSummary.addEventListener('click', function () {
    traceNotification.classList.remove('visible');
    vscode.postMessage({ command: 'notificationAction', action: 'summary' });
  });

  btnDismissNotification.addEventListener('click', function () {
    traceNotification.classList.remove('visible');
    vscode.postMessage({ command: 'notificationAction', action: 'dismiss' });
  });

  // ── Messages from extension ────────────────────────────────────────────

  window.addEventListener('message', function (event) {
    var msg = event.data;

    switch (msg.command) {
      case 'updateState':
        events = msg.events || [];
        currentIndex = msg.currentIndex;
        playState = msg.playState || 'stopped';
        if (currentIndex >= 0) {
          visitedSteps.add(currentIndex);
        }
        // Hide notification card when session state arrives
        traceNotification.classList.remove('visible');
        render();
        break;

      case 'clearSession':
        events = [];
        currentIndex = -1;
        visitedSteps = new Set();
        playState = 'stopped';
        collapsedSections = new Set();
        pregenProgress = { current: 0, total: 0, status: 'idle' };
        commentInputEventId = null;
        render();
        updatePregenProgress();
        break;

      case 'updatePregenProgress':
        pregenProgress = {
          current: msg.current,
          total: msg.total,
          status: msg.status
        };
        updatePregenProgress();
        break;

      case 'showTraceNotification':
        traceNotificationDetail.textContent = msg.stepCount + ' steps across ' + msg.fileCount + ' file' + (msg.fileCount !== 1 ? 's' : '');
        traceNotificationFilename.textContent = msg.fileName || '';
        traceNotification.classList.add('visible');
        // Hide the empty state while notification is showing
        emptyState.style.display = 'none';
        break;

      case 'showTransition':
        transitionText.textContent = 'Opening ' + msg.fileName + '...';
        transitionBanner.style.display = 'flex';
        break;

      case 'hideTransition':
        transitionBanner.style.display = 'none';
        break;
    }
  });

  // ── Initial render ─────────────────────────────────────────────────────
  render();

  // Signal to the extension that the webview is ready to receive messages
  vscode.postMessage({ command: 'ready' });
})();
