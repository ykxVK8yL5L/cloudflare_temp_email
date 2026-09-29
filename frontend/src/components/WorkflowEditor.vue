<script setup>
import { computed, ref } from 'vue'

const props = defineProps({ modelValue: { type: Object, required: true }, labels: { type: Object, required: true } })
const emit = defineEmits(['update:modelValue'])
const selectedId = ref('trigger')
const drag = ref(null)
const types = [
  'condition.filter', 'condition.switch', 'process.extract', 'process.delay', 'action.webhook',
  'action.forward', 'action.auto_reply', 'action.reject', 'action.stop'
]
const fields = ['from', 'to', 'subject', 'text', 'html', 'messageId', 'hasAttachments', 'attachmentCount', 'extract.type', 'extract.result', 'extract.result_text', 'extract.source']
const operators = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'matches', 'exists']
const extractSources = ['subject_text', 'subject', 'from', 'to', 'text', 'html', 'raw']
const nodes = computed(() => props.modelValue.nodes)
const edges = computed(() => props.modelValue.edges)
const selected = computed(() => nodes.value.find(n => n.id === selectedId.value))
const nodeMap = computed(() => Object.fromEntries(nodes.value.map(n => [n.id, n])))

const update = (definition) => emit('update:modelValue', { ...definition, version: 1 })
const addNode = (type) => {
  const id = `${type.replace('.', '-')}-${Date.now()}`
  const config = type === 'condition.filter' ? { field: 'subject', operator: 'contains', value: '' }
    : type === 'condition.switch' ? { field: 'subject', cases: [{ id: `case-${Date.now()}`, operator: 'equals', value: '', label: '' }] }
    : type === 'process.extract' ? { mode: 'smart', source: 'subject_text' }
    : type === 'process.delay' ? { seconds: 60 }
    : type === 'action.webhook' ? { url: '', method: 'POST', headers: '{"Content-Type":"application/json"}', body: '{"subject":"{{subject}}","text":"{{text}}"}' }
    : type === 'action.forward' ? { address: '' }
    : type === 'action.auto_reply' ? { subject: 'Auto-reply', body: '' }
    : type === 'action.reject' ? { reason: 'Rejected by workflow' } : {}
  const node = { id, type, name: props.labels[type], position: { x: 230 + (nodes.value.length % 3) * 230, y: 40 + Math.floor(nodes.value.length / 3) * 150 }, config }
  update({ ...props.modelValue, nodes: [...nodes.value, node] })
  selectedId.value = id
}
const removeNode = () => {
  if (!selected.value || selected.value.type === 'trigger.received') return
  update({ ...props.modelValue, nodes: nodes.value.filter(n => n.id !== selectedId.value), edges: edges.value.filter(e => e.source !== selectedId.value && e.target !== selectedId.value) })
  selectedId.value = 'trigger'
}
const setConfig = (key, value) => {
  const next = nodes.value.map(n => n.id === selectedId.value ? { ...n, config: { ...n.config, [key]: value } } : n)
  update({ ...props.modelValue, nodes: next })
}
const switchCases = computed(() => Array.isArray(selected.value?.config?.cases) ? selected.value.config.cases : [])
const addSwitchCase = () => {
  const nextId = `case-${Date.now()}`
  setConfig('cases', [...switchCases.value, { id: nextId, operator: 'equals', value: '', label: '' }])
}
const updateSwitchCase = (id, key, value) => setConfig('cases', switchCases.value.map(item => item.id === id ? { ...item, [key]: value } : item))
const removeSwitchCase = (id) => {
  const nextNodes = nodes.value.map(node => node.id === selectedId.value
    ? { ...node, config: { ...node.config, cases: switchCases.value.filter(item => item.id !== id) } }
    : node)
  update({ ...props.modelValue, nodes: nextNodes, edges: edges.value.filter(edge => !(edge.source === selectedId.value && edge.sourceHandle === id)) })
}
const setName = value => update({ ...props.modelValue, nodes: nodes.value.map(n => n.id === selectedId.value ? { ...n, name: value } : n) })
const targets = (handle = 'default') => edges.value.filter(e => e.source === selectedId.value && (e.sourceHandle || 'default') === handle).map(e => e.target)
const setTarget = (handle, target) => {
  const rest = edges.value.filter(e => !(e.source === selectedId.value && (e.sourceHandle || 'default') === handle))
  if (target) rest.push({ id: `edge-${selectedId.value}-${handle}`, source: selectedId.value, target, sourceHandle: handle })
  update({ ...props.modelValue, edges: rest })
}
const startDrag = (event, node) => {
  const rect = event.currentTarget.getBoundingClientRect()
  drag.value = { id: node.id, dx: event.clientX - rect.left, dy: event.clientY - rect.top }
}
const moveDrag = (event) => {
  if (!drag.value) return
  const rect = event.currentTarget.getBoundingClientRect()
  const next = nodes.value.map(n => n.id === drag.value.id ? { ...n, position: {
    x: Math.max(10, event.clientX - rect.left + event.currentTarget.scrollLeft - drag.value.dx),
    y: Math.max(10, event.clientY - rect.top + event.currentTarget.scrollTop - drag.value.dy)
  } } : n)
  update({ ...props.modelValue, nodes: next })
}
const stopDrag = () => { drag.value = null }
const line = (edge) => {
  const from = nodeMap.value[edge.source]?.position || { x: 0, y: 0 }
  const to = nodeMap.value[edge.target]?.position || { x: 0, y: 0 }
  return { x1: from.x + 170, y1: from.y + 35, x2: to.x, y2: to.y + 35 }
}
const targetOptions = computed(() => nodes.value.filter(n => n.id !== selectedId.value).map(n => ({ label: n.name || props.labels[n.type], value: n.id })))
</script>

<template>
  <div class="workflow-editor">
    <aside class="palette">
      <n-text strong>{{ labels.addNode }}</n-text>
      <n-button v-for="type in types" :key="type" size="small" block @click="addNode(type)">{{ labels[type] }}</n-button>
    </aside>
    <div class="canvas" @mousemove="moveDrag" @mouseup="stopDrag" @mouseleave="stopDrag">
      <svg class="connections">
        <line v-for="edge in edges" :key="edge.id" v-bind="line(edge)" :class="edge.sourceHandle || 'default'" />
      </svg>
      <button v-for="node in nodes" :key="node.id" class="node" :class="[{ selected: node.id === selectedId }, node.type.split('.')[0]]"
        :style="{ left: `${node.position?.x || 0}px`, top: `${node.position?.y || 0}px` }"
        @mousedown="startDrag($event, node)" @click="selectedId = node.id">
        <small>{{ node.type.split('.')[0] }}</small><strong>{{ node.name || labels[node.type] }}</strong>
      </button>
    </div>
    <aside class="properties" v-if="selected">
      <n-flex justify="space-between" align="center"><n-text strong>{{ labels.properties }}</n-text><n-button size="tiny" type="error" secondary :disabled="selected.type === 'trigger.received'" @click="removeNode">{{ labels.remove }}</n-button></n-flex>
      <n-form-item :label="labels.nodeName"><n-input :value="selected.name" @update:value="setName" /></n-form-item>
      <template v-if="selected.type === 'condition.filter'">
        <n-form-item :label="labels.field"><n-select :value="selected.config.field" :options="fields.map(v => ({label:v,value:v}))" @update:value="v => setConfig('field', v)" /></n-form-item>
        <n-form-item :label="labels.operator"><n-select :value="selected.config.operator" :options="operators.map(v => ({label:labels[v] || v,value:v}))" @update:value="v => setConfig('operator', v)" /></n-form-item>
        <n-form-item v-if="selected.config.operator !== 'exists'" :label="labels.value"><n-input :value="selected.config.value" @update:value="v => setConfig('value', v)" /></n-form-item>
      </template>
      <template v-if="selected.type === 'condition.switch'">
        <n-form-item :label="labels.field"><n-select :value="selected.config.field" :options="fields.map(v => ({label:v,value:v}))" @update:value="v => setConfig('field', v)" /></n-form-item>
        <n-flex vertical :size="8">
          <n-card v-for="(item, index) in switchCases" :key="item.id" size="small" :title="item.label || `${labels.switchCase} ${index + 1}`">
            <template #header-extra><n-button size="tiny" type="error" secondary @click="removeSwitchCase(item.id)">{{ labels.remove }}</n-button></template>
            <n-form-item :label="labels.caseName"><n-input :value="item.label" @update:value="v => updateSwitchCase(item.id, 'label', v)" /></n-form-item>
            <n-form-item :label="labels.operator"><n-select :value="item.operator" :options="operators.map(v => ({label:labels[v] || v,value:v}))" @update:value="v => updateSwitchCase(item.id, 'operator', v)" /></n-form-item>
            <n-form-item v-if="item.operator !== 'exists'" :label="labels.value"><n-input :value="item.value" @update:value="v => updateSwitchCase(item.id, 'value', v)" /></n-form-item>
            <n-form-item :label="labels.next"><n-select clearable :value="targets(item.id)[0]" :options="targetOptions" @update:value="v => setTarget(item.id, v)" /></n-form-item>
          </n-card>
          <n-button size="small" dashed block @click="addSwitchCase">{{ labels.addCase }}</n-button>
        </n-flex>
        <n-form-item :label="labels.defaultBranch"><n-select clearable :value="targets('default')[0]" :options="targetOptions" @update:value="v => setTarget('default', v)" /></n-form-item>
      </template>
      <template v-if="selected.type === 'process.extract'">
        <n-form-item :label="labels.extractMode"><n-select :value="selected.config.mode || 'smart'" :options="['smart','regex'].map(v => ({label:labels[`extractMode.${v}`],value:v}))" @update:value="v => setConfig('mode', v)" /></n-form-item>
        <n-form-item :label="labels.extractSource"><n-select :value="selected.config.source || 'subject_text'" :options="extractSources.map(v => ({label:labels[`extractSource.${v}`],value:v}))" @update:value="v => setConfig('source', v)" /></n-form-item>
        <template v-if="selected.config.mode === 'regex'">
          <n-form-item :label="labels.extractPattern"><n-input :value="selected.config.pattern" :placeholder="labels.extractPatternHint" @update:value="v => setConfig('pattern', v)" /></n-form-item>
          <n-form-item :label="labels.captureGroup"><n-input-number :value="selected.config.captureGroup ?? 1" :min="0" :max="20" @update:value="v => setConfig('captureGroup', v)" /></n-form-item>
          <n-form-item :label="labels.resultType"><n-input :value="selected.config.resultType || 'custom'" @update:value="v => setConfig('resultType', v)" /></n-form-item>
          <n-form-item :label="labels.resultLabel"><n-input :value="selected.config.resultLabel" @update:value="v => setConfig('resultLabel', v)" /></n-form-item>
          <n-form-item :label="labels.caseSensitive"><n-switch :value="selected.config.caseSensitive === true" @update:value="v => setConfig('caseSensitive', v)" /></n-form-item>
        </template>
        <n-alert type="info" :show-icon="false">{{ labels.extractOutputHint }}</n-alert>
      </template>
      <n-form-item v-if="selected.type === 'process.delay'" :label="labels.seconds"><n-input-number :value="selected.config.seconds" :min="1" :max="2592000" @update:value="v => setConfig('seconds', v)" /></n-form-item>
      <template v-if="selected.type === 'action.webhook'">
        <n-form-item label="URL"><n-input :value="selected.config.url" @update:value="v => setConfig('url', v)" /></n-form-item>
        <n-form-item :label="labels.method"><n-select :value="selected.config.method" :options="['GET','POST','PUT','PATCH'].map(v => ({label:v,value:v}))" @update:value="v => setConfig('method', v)" /></n-form-item>
        <n-form-item :label="labels.headers"><n-input type="textarea" :value="selected.config.headers" @update:value="v => setConfig('headers', v)" /></n-form-item>
        <n-form-item :label="labels.body"><n-input type="textarea" :value="selected.config.body" @update:value="v => setConfig('body', v)" /></n-form-item>
      </template>
      <n-form-item v-if="selected.type === 'action.forward'" :label="labels.address"><n-input :value="selected.config.address" @update:value="v => setConfig('address', v)" /></n-form-item>
      <template v-if="selected.type === 'action.auto_reply'">
        <n-form-item :label="labels.subject"><n-input :value="selected.config.subject" @update:value="v => setConfig('subject', v)" /></n-form-item>
        <n-form-item :label="labels.body"><n-input type="textarea" :value="selected.config.body" @update:value="v => setConfig('body', v)" /></n-form-item>
      </template>
      <n-form-item v-if="selected.type === 'action.reject'" :label="labels.reason"><n-input :value="selected.config.reason" @update:value="v => setConfig('reason', v)" /></n-form-item>
      <n-divider />
      <template v-if="selected.type === 'condition.filter'">
        <n-form-item :label="labels.trueBranch"><n-select clearable :value="targets('true')[0]" :options="targetOptions" @update:value="v => setTarget('true', v)" /></n-form-item>
        <n-form-item :label="labels.falseBranch"><n-select clearable :value="targets('false')[0]" :options="targetOptions" @update:value="v => setTarget('false', v)" /></n-form-item>
      </template>
      <n-form-item v-else-if="selected.type !== 'condition.switch' && selected.type !== 'action.stop' && selected.type !== 'action.reject'" :label="labels.next"><n-select clearable :value="targets()[0]" :options="targetOptions" @update:value="v => setTarget('default', v)" /></n-form-item>
      <template v-if="['process.extract','action.webhook'].includes(selected.type)">
        <n-form-item :label="labels.retries"><n-input-number :value="selected.config.retryLimit ?? 2" :min="0" :max="5" @update:value="v => setConfig('retryLimit', v)" /></n-form-item>
      </template>
    </aside>
  </div>
</template>

<style scoped>
.workflow-editor{display:grid;grid-template-columns:170px minmax(420px,1fr) 280px;gap:12px;min-height:580px}.palette,.properties{border:1px solid var(--n-border-color);border-radius:8px;padding:12px;overflow:auto}.palette .n-button{margin-top:8px}.canvas{position:relative;overflow:auto;min-height:580px;border-radius:8px;background-color:rgba(128,128,128,.06);background-image:radial-gradient(rgba(128,128,128,.35) 1px,transparent 1px);background-size:20px 20px}.connections{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.connections line{stroke:#8b8b8b;stroke-width:2}.connections line.true{stroke:#18a058}.connections line.false{stroke:#d03050}.node{position:absolute;width:170px;min-height:70px;text-align:left;border:2px solid #8b8b8b;border-radius:10px;background:var(--n-color,#fff);color:inherit;padding:10px;cursor:move;box-shadow:0 4px 14px rgba(0,0,0,.1)}.node small,.node strong{display:block}.node small{opacity:.6;text-transform:uppercase}.node.selected{border-color:#2080f0}.node.trigger{border-color:#18a058}.node.condition{border-color:#f0a020}.node.action{border-color:#8a2be2}.properties :deep(.n-form-item){margin-top:8px}@media(max-width:900px){.workflow-editor{grid-template-columns:1fr}.canvas{min-height:420px}.properties{min-height:300px}}
</style>
