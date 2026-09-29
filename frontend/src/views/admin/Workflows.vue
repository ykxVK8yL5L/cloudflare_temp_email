<script setup>
import { computed, h, onMounted, ref } from 'vue'
import { NButton, NPopconfirm, NSpace, useMessage } from 'naive-ui'
import { api } from '../../api'
import WorkflowEditor from '../../components/WorkflowEditor.vue'
import { useScopedI18n } from '@/i18n/app'

const message = useMessage()
const { t } = useScopedI18n('views.admin.Workflows')
const workflows = ref([])
const runs = ref([])
const editing = ref(null)
const showEditor = ref(false)
const showRuns = ref(false)
const showRunDetail = ref(false)
const runDetail = ref(null)
const testMailId = ref(null)
const checkedRunIds = ref([])
const currentRunsWorkflow = ref(null)

const labelKeys = ['addNode','properties','remove','nodeName','field','operator','value','seconds','method','headers','body','address','subject','reason','next','trueBranch','falseBranch','defaultBranch','switchCase','caseName','addCase','retries','extractMode','extractSource','extractPattern','extractPatternHint','captureGroup','resultType','resultLabel','caseSensitive','extractOutputHint','extractMode.smart','extractMode.regex','extractSource.subject_text','extractSource.subject','extractSource.from','extractSource.to','extractSource.text','extractSource.html','extractSource.raw','equals','not_equals','contains','not_contains','starts_with','ends_with','matches','exists','trigger.received','condition.filter','condition.switch','process.extract','process.delay','action.webhook','action.forward','action.auto_reply','action.reject','action.stop']
const labels = computed(() => Object.fromEntries(labelKeys.map(key => [key, t(key)])))
const blank = () => ({
  id: null, name: t('newWorkflowName'), description: '', enabled: false, priority: 0,
  definition: { version: 1, nodes: [{ id: 'trigger', type: 'trigger.received', name: labels.value['trigger.received'], position: { x: 30, y: 60 }, config: {} }], edges: [] }
})
const fetchData = async () => { workflows.value = await api.fetch('/admin/workflows') }
const edit = async row => { editing.value = row ? JSON.parse(JSON.stringify(await api.fetch(`/admin/workflows/${row.id}`))) : blank(); showEditor.value = true }
const save = async () => {
  try {
    const path = editing.value.id ? `/admin/workflows/${editing.value.id}` : '/admin/workflows'
    editing.value = await api.fetch(path, { method: editing.value.id ? 'PUT' : 'POST', body: JSON.stringify(editing.value) })
    message.success(t('saveSuccess')); showEditor.value = false; await fetchData()
  } catch (error) { message.error(error.message) }
}
const remove = async row => { try { await api.fetch(`/admin/workflows/${row.id}`, { method: 'DELETE' }); message.success(t('deleteSuccess')); await fetchData() } catch (e) { message.error(e.message) } }
const test = async row => { try { const res = await api.fetch(`/admin/workflows/${row.id}/test`, { method: 'POST', body: JSON.stringify({ mail_id: testMailId.value || undefined }) }); message.success(t('testStarted', { id: res.runId })); await openRuns(row) } catch (e) { message.error(e.message) } }
const refreshRuns = async () => {
  if (!currentRunsWorkflow.value) return
  runs.value = await api.fetch(`/admin/workflows/runs?workflow_id=${currentRunsWorkflow.value.id}`)
  checkedRunIds.value = checkedRunIds.value.filter(id => runs.value.some(run => run.id === id))
}
const openRuns = async row => { currentRunsWorkflow.value = row; checkedRunIds.value = []; await refreshRuns(); showRuns.value = true }
const openRunDetail = async row => { runDetail.value = await api.fetch(`/admin/workflows/runs/${row.id}`); showRunDetail.value = true }
const removeRun = async row => {
  try {
    await api.fetch(`/admin/workflows/runs/${row.id}`, { method: 'DELETE' })
    checkedRunIds.value = checkedRunIds.value.filter(id => id !== row.id)
    message.success(t('runDeleteSuccess'))
    await Promise.all([refreshRuns(), fetchData()])
  } catch (e) { message.error(e.message) }
}
const removeSelectedRuns = async () => {
  if (!checkedRunIds.value.length) return
  try {
    const count = checkedRunIds.value.length
    await api.fetch('/admin/workflows/runs', { method: 'DELETE', body: JSON.stringify({ ids: checkedRunIds.value }) })
    checkedRunIds.value = []
    message.success(t('runsDeleteSuccess', { count }))
    await Promise.all([refreshRuns(), fetchData()])
  } catch (e) { message.error(e.message) }
}
const columns = computed(() => [
  { title: t('name'), key: 'name' }, { title: t('status'), key: 'enabled', render: row => row.enabled ? t('enabled') : t('disabled') },
  { title: t('priority'), key: 'priority' }, { title: t('runCount'), key: 'run_count' }, { title: t('lastStatus'), key: 'last_status' },
  { title: t('actions'), key: 'actions', render: row => h(NSpace, {}, () => [
    h(NButton, { size: 'small', onClick: () => edit(row) }, () => t('edit')),
    h(NButton, { size: 'small', onClick: () => test(row) }, () => t('test')),
    h(NButton, { size: 'small', onClick: () => openRuns(row) }, () => t('history')),
    h(NPopconfirm, { onPositiveClick: () => remove(row) }, { trigger: () => h(NButton, { size: 'small', type: 'error', secondary: true }, () => t('delete')), default: () => t('deleteConfirm') })
  ]) }
])
const runColumns = computed(() => [
  { type: 'selection', disabled: row => row.status === 'running' },
  { title: t('startedAt'), key: 'started_at' }, { title: t('status'), key: 'status' }, { title: t('mailId'), key: 'mail_id' },
  { title: t('duration'), key: 'duration_ms' }, { title: t('error'), key: 'error', ellipsis: { tooltip: true } },
  { title: t('actions'), key: 'actions', render: row => h(NSpace, {}, () => [
    h(NButton, { size: 'small', onClick: () => openRunDetail(row) }, () => t('details')),
    h(NPopconfirm, { disabled: row.status === 'running', onPositiveClick: () => removeRun(row) }, {
      trigger: () => h(NButton, { size: 'small', type: 'error', secondary: true, disabled: row.status === 'running' }, () => t('delete')),
      default: () => t('runDeleteConfirm'),
    }),
  ]) }
])
const stepColumns = [
  { title: t('nodeName'), key: 'node_id' }, { title: t('nodeType'), key: 'node_type' }, { title: t('status'), key: 'status' },
  { title: t('attempt'), key: 'attempt' }, { title: t('duration'), key: 'duration_ms' },
  { title: t('output'), key: 'output', ellipsis: { tooltip: true } }, { title: t('error'), key: 'error', ellipsis: { tooltip: true } }
]
onMounted(fetchData)
</script>

<template>
  <div class="workflows-page">
    <n-card :title="t('title')" :bordered="false">
      <n-alert type="info" style="margin-bottom:12px">{{ t('hint') }}</n-alert>
      <n-flex justify="space-between" align="center">
        <n-input-number v-model:value="testMailId" clearable :placeholder="t('testMailPlaceholder')" style="width:260px" />
        <n-button type="primary" @click="edit(null)">{{ t('newWorkflow') }}</n-button>
      </n-flex>
      <n-data-table style="margin-top:12px" :columns="columns" :data="workflows" :row-key="row => row.id" />
    </n-card>

    <n-modal v-model:show="showEditor" preset="card" style="width:min(1500px,96vw)" :title="t('editor')">
      <n-grid :cols="4" :x-gap="12">
        <n-form-item-gi :label="t('name')"><n-input v-model:value="editing.name" /></n-form-item-gi>
        <n-form-item-gi :label="t('description')"><n-input v-model:value="editing.description" /></n-form-item-gi>
        <n-form-item-gi :label="t('priority')"><n-input-number v-model:value="editing.priority" :min="-1000" :max="1000" /></n-form-item-gi>
        <n-form-item-gi :label="t('enabled')"><n-switch v-model:value="editing.enabled" /></n-form-item-gi>
      </n-grid>
      <n-checkbox v-model:checked="editing.definition.skipDefaultActions" style="margin-bottom:12px">{{ t('skipDefaultActions') }}</n-checkbox>
      <WorkflowEditor v-model="editing.definition" :labels="labels" />
      <template #footer><n-flex justify="end"><n-button @click="showEditor=false">{{ t('cancel') }}</n-button><n-button type="primary" @click="save">{{ t('save') }}</n-button></n-flex></template>
    </n-modal>

    <n-modal v-model:show="showRuns" preset="card" style="width:min(1100px,94vw)" :title="t('runHistory')">
      <n-flex justify="end" style="margin-bottom:12px">
        <n-popconfirm :disabled="!checkedRunIds.length" @positive-click="removeSelectedRuns">
          <template #trigger><n-button type="error" secondary :disabled="!checkedRunIds.length">{{ t('deleteSelectedRuns', { count: checkedRunIds.length }) }}</n-button></template>
          {{ t('runsDeleteConfirm', { count: checkedRunIds.length }) }}
        </n-popconfirm>
      </n-flex>
      <n-data-table v-model:checked-row-keys="checkedRunIds" :columns="runColumns" :data="runs" :row-key="row => row.id" />
    </n-modal>
    <n-modal v-model:show="showRunDetail" preset="card" style="width:min(1100px,94vw)" :title="t('runDetails')">
      <n-descriptions v-if="runDetail" bordered :column="2">
        <n-descriptions-item label="ID">{{ runDetail.id }}</n-descriptions-item>
        <n-descriptions-item :label="t('status')">{{ runDetail.status }}</n-descriptions-item>
        <n-descriptions-item :label="t('startedAt')">{{ runDetail.started_at }}</n-descriptions-item>
        <n-descriptions-item :label="t('duration')">{{ runDetail.duration_ms }}</n-descriptions-item>
      </n-descriptions>
      <n-data-table v-if="runDetail" style="margin-top:12px" :columns="stepColumns" :data="runDetail.steps" :row-key="row => row.id" />
    </n-modal>
  </div>
</template>

<style scoped>.workflows-page{padding:8px}.workflows-page :deep(.n-card){overflow:auto}</style>
