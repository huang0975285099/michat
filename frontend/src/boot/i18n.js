import { defineBoot } from '#q-app/wrappers'
import { watch } from 'vue'
import enUS from 'quasar/lang/en-US'
import zhCN from 'quasar/lang/zh-CN'

import { useI18n } from 'src/i18n'

const quasarLanguages = {
  'en-US': enUS,
  'zh-CN': zhCN
}

export default defineBoot(({ app }) => {
  const $q = app.config.globalProperties.$q
  const { locale } = useI18n()
  const applyLanguage = value => $q.lang.set(quasarLanguages[value] || enUS)

  applyLanguage(locale.value)
  watch(locale, applyLanguage)
})
