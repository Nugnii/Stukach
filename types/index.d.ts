// Погода: последний запрос основной сессии к модели — от него считается жизнь кеша.
export type CacheMark = { at: number; ttl: '5m' | '1h' }

// Погода: сообщение, придержанное на остывшем кеше — когда, сколько минут кеш стоял, сколько токенов перечитает,
// и для модели с ценой — во сколько обойдётся отправка сейчас и сколько стоила бы с тёплым кешем ($).
export type Armed = { at: number; minutes: number; tokens: number; cold?: number; warm?: number }

declare module 'claude-code' {
  interface PluginState {
    stukach: {
      cache: CacheMark | null
      armed: Armed | null
      expanded: boolean // статистика раскрыта: история с графиками
      gear: boolean // открыты настройки
    }
  }
}
