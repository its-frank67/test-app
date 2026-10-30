'use strict';

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FUZZY_VALUES = 1800;

const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const errorMessage = document.getElementById('errorMessage');
const settingsPanel = document.getElementById('settingsPanel');
const resultsSection = document.getElementById('resultsSection');
const scanMode = document.getElementById('scanMode');
const thresholdInput = document.getElementById('threshold');
const thresholdValue = document.getElementById('thresholdValue');
const firstRowHeader = document.getElementById('firstRowHeader');
const ignoreShortWords = document.getElementById('ignoreShortWords');
const resultsList = document.getElementById('resultsList');
const scanWarning = document.getElementById('scanWarning');
const downloadButton = document.getElementById('downloadButton');

let loadedFile = null;
let parsedRows = [];
let currentGroups = [];
let currentFilter = 'all';
let currentSummary = null;

// Open the file picker when the upload area is clicked or activated by keyboard.
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (file) loadFile(file);
  fileInput.value = '';
});

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('drag-active');
});

dropZone.addEventListener('dragleave', (event) => {
  if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('drag-active');
});

dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('drag-active');
  const file = event.dataTransfer && event.dataTransfer.files[0];
  if (file) loadFile(file);
});

for (const control of [scanMode, thresholdInput, firstRowHeader, ignoreShortWords]) {
  control.addEventListener('change', () => {
    thresholdValue.textContent = `${thresholdInput.value}%`;
    if (loadedFile && parsedRows.length) runScan();
  });
}

thresholdInput.addEventListener('input', () => {
  thresholdValue.textContent = `${thresholdInput.value}%`;
});

document.getElementById('scanButton').addEventListener('click', runScan);
document.getElementById('clearFileButton').addEventListener('click', clearFile);
downloadButton.addEventListener('click', downloadReport);

document.querySelectorAll('.filter-tab').forEach((button) => {
  button.addEventListener('click', () => {
    currentFilter = button.dataset.filter;
    document.querySelectorAll('.filter-tab').forEach((tab) => {
      const selected = tab.dataset.filter === currentFilter;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    renderResults();
  });
});

async function loadFile(file) {
  hideError();
  const fileName = file.name.toLowerCase();
  if (!fileName.endsWith('.csv') && !fileName.endsWith('.txt')) {
    showError('Please choose a .csv file. Export your spreadsheet as CSV before uploading it.');
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    showError('This file is larger than 20 MB. Try exporting a smaller spreadsheet.');
    return;
  }
  if (file.size === 0) {
    showError('That file is empty. Choose a CSV file that contains spreadsheet data.');
    return;
  }

  try {
    const text = await file.text();
    const cleanedText = text.replace(/^\uFEFF/, '');
    const delimiter = detectDelimiter(cleanedText);
    const result = parseDelimitedText(cleanedText, delimiter);
    if (result.rows.length === 0) {
      showError('No spreadsheet rows were found in that file.');
      return;
    }

    loadedFile = file;
    parsedRows = result.rows;
    currentFilter = 'all';
    document.getElementById('fileName').textContent = file.name;
    document.getElementById('fileInfo').textContent = `${formatBytes(file.size)} · ${result.rows.length.toLocaleString()} rows detected`;
    settingsPanel.hidden = false;
    resultsSection.hidden = false;
    resetFilterTabs();
    runScan();
  } catch (error) {
    console.error(error);
    showError('The file could not be read. Make sure it is a valid CSV file and try again.');
  }
}

function detectDelimiter(text) {
  const candidates = [',', '\t', ';', '|'];
  const sample = text.split(/\r?\n/).slice(0, 8).join('\n');
  let bestDelimiter = ',';
  let bestCount = -1;

  for (const delimiter of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let index = 0; index < sample.length; index += 1) {
      const character = sample[index];
      if (character === '"') {
        if (inQuotes && sample[index + 1] === '"') index += 1;
        else inQuotes = !inQuotes;
      } else if (character === delimiter && !inQuotes) {
        count += 1;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      bestDelimiter = delimiter;
    }
  }
  return bestDelimiter;
}

// A small CSV/TSV parser that supports quoted commas, escaped quotes and line breaks.
function parseDelimitedText(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let lineNumber = 1;
  let rowStartLine = 1;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (inQuotes) {
        inQuotes = false;
      } else if (cell.length === 0) {
        inQuotes = true;
      } else {
        cell += character;
      }
      continue;
    }

    if (character === delimiter && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if (character === '\n' || character === '\r') {
      const isWindowsNewline = character === '\r' && text[index + 1] === '\n';
      if (inQuotes) {
        cell += '\n';
      } else {
        row.push(cell);
        if (row.some((value) => value.trim() !== '')) {
          rows.push({ cells: row, line: rowStartLine });
        }
        row = [];
        cell = '';
        rowStartLine = lineNumber + 1;
      }
      if (isWindowsNewline) index += 1;
      lineNumber += 1;
      continue;
    }

    cell += character;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== '')) {
      rows.push({ cells: row, line: rowStartLine });
    }
  }

  return { rows, hasUnclosedQuote: inQuotes };
}

function runScan() {
  if (!loadedFile || parsedRows.length === 0) return;

  const hasHeader = firstRowHeader.checked;
  const headerRow = hasHeader ? parsedRows[0].cells : [];
  const dataRows = hasHeader ? parsedRows.slice(1) : parsedRows;
  const mode = scanMode.value;
  const entries = new Map();
  let valuesChecked = 0;
  let widestRow = 0;

  for (const row of parsedRows) widestRow = Math.max(widestRow, row.cells.length);

  for (const row of dataRows) {
    for (let columnIndex = 0; columnIndex < row.cells.length; columnIndex += 1) {
      const rawCell = String(row.cells[columnIndex] ?? '').trim();
      if (!rawCell) continue;

      const columnName = hasHeader
        ? String(headerRow[columnIndex] ?? '').trim() || `Column ${columnIndex + 1}`
        : `Column ${columnIndex + 1}`;
      const parts = mode === 'cells' ? [rawCell] : tokenize(rawCell);

      for (const part of parts) {
        const display = part.trim();
        if (!display) continue;
        const normalized = normalizeValue(display);
        const isNumber = isNumericValue(normalized);
        if (!normalized) continue;
        if (mode === 'words' && !isNumber && ignoreShortWords.checked && countLetters(normalized) < 3) continue;

        valuesChecked += 1;
        let entry = entries.get(normalized);
        if (!entry) {
          entry = {
            key: normalized,
            value: display,
            isNumber,
            count: 0,
            locations: [],
            spellings: new Map()
          };
          entries.set(normalized, entry);
        }
        entry.count += 1;
        entry.spellings.set(display, (entry.spellings.get(display) || 0) + 1);
        if (entry.locations.length < 24) {
          entry.locations.push({ row: row.line, column: columnName });
        }
      }
    }
  }

  const uniqueEntries = Array.from(entries.values());
  const exactGroups = uniqueEntries
    .filter((entry) => entry.count > 1)
    .map((entry) => ({
      id: `exact-${entry.key}`,
      type: 'exact',
      values: [entry],
      totalCount: entry.count,
      score: 100
    }));

  const fuzzyResult = buildSimilarGroups(uniqueEntries, Number(thresholdInput.value), mode);
  currentGroups = [...fuzzyResult.groups, ...exactGroups].sort((first, second) => {
    if (first.type !== second.type) return first.type === 'similar' ? -1 : 1;
    return second.totalCount - first.totalCount;
  });
  currentSummary = {
    valuesChecked,
    uniqueValues: uniqueEntries.length,
    similarGroups: fuzzyResult.groups.length,
    exactGroups: exactGroups.length
  };

  document.getElementById('valuesChecked').textContent = valuesChecked.toLocaleString();
  document.getElementById('similarCount').textContent = fuzzyResult.groups.length.toLocaleString();
  document.getElementById('exactCount').textContent = exactGroups.length.toLocaleString();
  document.getElementById('allTabCount').textContent = currentGroups.length.toLocaleString();
  document.getElementById('similarTabCount').textContent = fuzzyResult.groups.length.toLocaleString();
  document.getElementById('exactTabCount').textContent = exactGroups.length.toLocaleString();
  document.getElementById('resultsSubtitle').textContent =
    `${uniqueEntries.length.toLocaleString()} unique values found across ${dataRows.length.toLocaleString()} data rows.`;

  if (fuzzyResult.limited) {
    scanWarning.hidden = false;
    scanWarning.textContent = `This file contains many unique values. Similarity checking compared the ${MAX_FUZZY_VALUES.toLocaleString()} most frequent unique values to keep scanning responsive. Exact repeat detection still checked the entire file.`;
  } else {
    scanWarning.hidden = true;
    scanWarning.textContent = '';
  }

  downloadButton.disabled = currentGroups.length === 0;
  renderResults();
}

function tokenize(value) {
  return value.match(/[\p{L}]+(?:[’'][\p{L}]+)*|\d+(?:[.,]\d+)*/gu) || [];
}

function normalizeValue(value) {
  return String(value).normalize('NFKC').trim().toLocaleLowerCase();
}

function isNumericValue(value) {
  return /^[+-]?\d+(?:[.,]\d+)*$/.test(value);
}

function countLetters(value) {
  const matches = value.match(/\p{L}/gu);
  return matches ? matches.length : 0;
}

function buildSimilarGroups(entries, threshold, mode) {
  const sorted = entries
    .filter((entry) => entry.key.length >= 3)
    .sort((first, second) => second.count - first.count || first.key.length - second.key.length);
  const limited = sorted.length > MAX_FUZZY_VALUES;
  const candidates = sorted.slice(0, MAX_FUZZY_VALUES);
  const groups = [];
  const indexes = new Map();

  for (const entry of candidates) {
    const possibleGroupIds = findCandidateGroups(entry, indexes);
    let chosenGroup = null;
    let chosenScore = -1;

    for (const groupId of possibleGroupIds) {
      const group = groups[groupId];
      if (group.values.some((member) => member.isNumber !== entry.isNumber)) continue;
      if (entry.isNumber && group.values.some((member) => member.key.length !== entry.key.length)) continue;
      if (!entry.isNumber && group.values.some((member) => Math.abs(member.key.length - entry.key.length) > 1)) continue;

      const scores = group.values.map((member) => similarityScore(member.key, entry.key));
      if (scores.every((score) => score >= threshold)) {
        const averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
        if (averageScore > chosenScore) {
          chosenScore = averageScore;
          chosenGroup = group;
        }
      }
    }

    if (chosenGroup) {
      chosenGroup.values.push(entry);
      chosenGroup.totalCount += entry.count;
      chosenGroup.score = Math.min(chosenGroup.score, chosenScore);
      addGroupToIndex(chosenGroup, indexes);
    } else {
      const group = {
        id: `similar-${groups.length}`,
        type: 'similar',
        values: [entry],
        totalCount: entry.count,
        score: 100
      };
      groups.push(group);
      addGroupToIndex(group, indexes);
    }
  }

  const matches = groups.filter((group) => group.values.length > 1);
  for (const group of matches) {
    group.values.sort((first, second) => second.count - first.count || first.value.localeCompare(second.value));
  }
  return { groups: matches, limited };
}

function findCandidateGroups(entry, indexes) {
  const lengthOffsets = entry.isNumber ? [0] : [-1, 0, 1];
  const ids = new Set();
  for (const offset of lengthOffsets) {
    const length = entry.key.length + offset;
    if (length < 1) continue;
    const firstKey = makeIndexKey(entry.isNumber, length, 'first', entry.key[0]);
    const lastKey = makeIndexKey(entry.isNumber, length, 'last', entry.key[entry.key.length - 1]);
    for (const id of indexes.get(firstKey) || []) ids.add(id);
    for (const id of indexes.get(lastKey) || []) ids.add(id);
  }
  return ids;
}

function addGroupToIndex(group, indexes) {
  const groupId = Number(group.id.split('-')[1]);
  for (const entry of group.values) {
    const length = entry.key.length;
    const keys = [
      makeIndexKey(entry.isNumber, length, 'first', entry.key[0]),
      makeIndexKey(entry.isNumber, length, 'last', entry.key[entry.key.length - 1])
    ];
    for (const key of keys) {
      if (!indexes.has(key)) indexes.set(key, new Set());
      indexes.get(key).add(groupId);
    }
  }
}

function makeIndexKey(isNumber, length, position, character) {
  return `${isNumber ? 'n' : 'w'}:${length}:${position}:${character}`;
}

// Optimal-string-alignment edit distance also recognizes adjacent letter swaps.
function similarityScore(first, second) {
  if (first === second) return 100;
  const longest = Math.max(first.length, second.length);
  if (longest === 0) return 100;
  const distance = damerauLevenshtein(first, second);
  return (1 - distance / longest) * 100;
}

function damerauLevenshtein(first, second) {
  const rows = first.length + 1;
  const columns = second.length + 1;
  const matrix = Array.from({ length: rows }, () => new Array(columns).fill(0));

  for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
  for (let column = 0; column < columns; column += 1) matrix[0][column] = column;

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = first[row - 1] === second[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + cost
      );
      if (
        row > 1 && column > 1 &&
        first[row - 1] === second[column - 2] &&
        first[row - 2] === second[column - 1]
      ) {
        matrix[row][column] = Math.min(matrix[row][column], matrix[row - 2][column - 2] + 1);
      }
    }
  }
  return matrix[rows - 1][columns - 1];
}

function renderResults() {
  resultsList.replaceChildren();
  const filtered = currentGroups.filter((group) => currentFilter === 'all' || group.type === currentFilter);

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('strong');
    title.textContent = currentGroups.length === 0 ? 'No matches found' : `No ${currentFilter} matches`;
    const description = document.createElement('p');
    description.textContent = currentGroups.length === 0
      ? 'Try lowering the similarity percentage, or check that your spreadsheet has the right data.'
      : 'Choose another results tab to see the other groups.';
    empty.append(title, description);
    resultsList.append(empty);
    return;
  }

  for (const group of filtered) resultsList.append(createResultCard(group));
}

function createResultCard(group) {
  const card = document.createElement('article');
  card.className = `result-card ${group.type}`;

  const header = document.createElement('div');
  header.className = 'result-card-header';
  const kind = document.createElement('span');
  kind.className = 'result-kind';
  const dot = document.createElement('span');
  dot.className = 'kind-dot';
  const kindText = document.createElement('span');
  kindText.textContent = group.type === 'exact' ? 'Exact repeat' : 'Possible similar values';
  kind.append(dot, kindText);

  const meta = document.createElement('span');
  meta.className = 'result-meta';
  meta.textContent = group.type === 'exact'
    ? `${group.totalCount.toLocaleString()} occurrences`
    : `${Math.round(group.score)}% match · ${group.totalCount.toLocaleString()} occurrences`;
  header.append(kind, meta);

  const variants = document.createElement('div');
  variants.className = 'variant-list';
  for (const entry of group.values) variants.append(createVariantRow(entry));
  card.append(header, variants);
  return card;
}

function createVariantRow(entry) {
  const row = document.createElement('div');
  row.className = 'variant-row';

  const value = document.createElement('div');
  value.className = 'variant-value';
  value.textContent = entry.value;

  const count = document.createElement('span');
  count.className = 'variant-count';
  count.textContent = `${entry.count.toLocaleString()} ${entry.count === 1 ? 'occurrence' : 'occurrences'}`;

  const locations = document.createElement('div');
  locations.className = 'variant-locations';
  for (const location of entry.locations.slice(0, 8)) {
    const chip = document.createElement('span');
    chip.className = 'location-chip';
    chip.textContent = `Row ${location.row} · ${location.column}`;
    locations.append(chip);
  }
  if (entry.count > entry.locations.length) {
    const more = document.createElement('span');
    more.className = 'location-chip';
    more.textContent = `+${(entry.count - entry.locations.length).toLocaleString()} more`;
    locations.append(more);
  }

  row.append(value, count, locations);
  const spellings = Array.from(entry.spellings.entries());
  if (spellings.length > 1) {
    const note = document.createElement('div');
    note.className = 'spelling-note';
    note.textContent = `Capitalization/format variations: ${spellings.map(([spelling, amount]) => `${spelling} (${amount})`).join(', ')}`;
    row.append(note);
  }
  return row;
}

function downloadReport() {
  if (!currentGroups.length) return;
  const rows = [['Match type', 'Match score', 'Value', 'Occurrences', 'Spreadsheet locations']];
  for (const group of currentGroups) {
    for (const entry of group.values) {
      const places = entry.locations.map((location) => `Row ${location.row} - ${location.column}`).join('; ');
      rows.push([
        group.type === 'exact' ? 'Exact repeat' : 'Similar value',
        group.type === 'exact' ? '100%' : `${Math.round(group.score)}%`,
        entry.value,
        String(entry.count),
        places
      ]);
    }
  }
  const csv = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'spreadsheet-similarity-report.csv';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function escapeCsvCell(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function clearFile() {
  loadedFile = null;
  parsedRows = [];
  currentGroups = [];
  currentSummary = null;
  settingsPanel.hidden = true;
  resultsSection.hidden = true;
  hideError();
  scanWarning.hidden = true;
  resultsList.replaceChildren();
}

function resetFilterTabs() {
  currentFilter = 'all';
  document.querySelectorAll('.filter-tab').forEach((tab) => {
    const selected = tab.dataset.filter === 'all';
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  });
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

function hideError() {
  errorMessage.hidden = true;
  errorMessage.textContent = '';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
