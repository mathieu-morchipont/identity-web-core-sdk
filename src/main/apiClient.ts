import WinChan from 'winchan'
import isEmpty from 'lodash-es/isEmpty'
import pick from 'lodash-es/pick'

import { logError } from '../lib/logger'
import { QueryString, toQueryString } from '../lib/queryString'
import { camelCaseProperties, snakeCaseProperties } from '../lib/transformObjectProperties'

import { ProviderId } from '../shared/providers/providers'
import providerSizes from '../shared/providers/provider-window-sizes'
import { ErrorResponse, Profile } from '../shared/model'
import { AuthOptions, prepareAuthOptions, resolveScope } from './authOptions'
import { AuthResult, enrichAuthResult } from './authResult'
import { ajax } from './ajax'
import { IdentityEventManager } from './identityEventManager'
import { UrlParser } from './urlParser'

type RequestParams = {
  method?: 'GET' | 'POST'
  params?: QueryString
  body?: {}
  accessToken?: string
  withCookies?: boolean
}

export type SignupParams = { data: Profile, auth?: AuthOptions }

export type LoginWithPasswordParams = { email: string, password: string, auth?: AuthOptions }

export type PasswordlessParams = { authType: 'magic_link' | 'sms', email?: string, phoneNumber?: string }

export type ApiClientConfig = {
  clientId: string
  domain: string
  language?: string
  sso: boolean
}

/**
 * Identity Rest API Client
 */
export default class ApiClient {

  constructor(props: { config: ApiClientConfig, eventManager: IdentityEventManager, urlParser: UrlParser }) {
    this.config = props.config
    this.eventManager = props.eventManager
    this.urlParser = props.urlParser
    this.baseUrl = `https://${this.config.domain}/identity/v1`
    this.authorizeUrl = `https://${this.config.domain}/oauth/authorize`
    this.tokenUrl = `https://${this.config.domain}/oauth/token`
    this.popupRelayUrl = `https://${this.config.domain}/popup/relay`

    this.initCordovaCallbackIfNecessary()
  }

  private config: ApiClientConfig
  private eventManager: IdentityEventManager
  private urlParser: UrlParser
  private baseUrl: string
  private authorizeUrl: string
  private tokenUrl: string
  private popupRelayUrl: string


  loginWithSocialProvider(provider: ProviderId, opts: AuthOptions = {}): Promise<void> {
    const authParams = this.authParams(opts, { acceptPopupMode: true })

    const params = {
      ...authParams,
      provider
    }
    if ('cordova' in window) {
      return this.loginWithCordovaInAppBrowser(params)
    }
    else if (params.display === 'popup') {
      return this.loginWithPopup(params)
    }
    else {
      return this.loginWithRedirect(params)
    }
  }

  loginFromSession(opts: AuthOptions = {}): Promise<void> {
    if (!this.config.sso && !opts.idTokenHint) {
      return Promise.reject(new Error("Cannot call 'loginFromSession' without 'idTokenHint' parameter if SSO is not enabled."))
    }
    return this.loginWithRedirect({
      ...this.authParams(opts),
      prompt: 'none'
    })
  }

  logout(opts: { redirect_to?: string }) {
    window.location.assign(`${this.baseUrl}/logout?${toQueryString(opts)}`)
  }

  private loginWithRedirect(queryString: Record<string, string | boolean | undefined>): Promise<void> {
    window.location.assign(`${this.authorizeUrl}?${toQueryString(queryString)}`)
    return Promise.resolve()
  }

  private loginWithCordovaInAppBrowser(opts: QueryString): Promise<void> {
    const params = {
      ...opts,
      display: 'page'
    }
    return this.openInCordovaSystemBrowser(`${this.authorizeUrl}?${toQueryString(params)}`)
  }

  private openInCordovaSystemBrowser(url: string): Promise<void> {
    return this.getAvailableBrowserTabPlugin().then(maybeBrowserTab => {
      if (!window.cordova) {
        throw new Error('Cordova environnement not detected.')
      }

      if (maybeBrowserTab) {
        maybeBrowserTab.openUrl(url, () => {}, logError)
      }
      else if (window.cordova.InAppBrowser) {
        window.cordova.InAppBrowser.open(url, '_system')
      }
      else {
        throw new Error('Cordova plugin "inappbrowser" is required.')
      }
    })
  }

  private getAvailableBrowserTabPlugin(): Promise<BrowserTab | undefined> {
    return new Promise((resolve, reject) => {
      const cordova = window.cordova

      if (!cordova || !cordova.plugins || !cordova.plugins.browsertab)
        return resolve(undefined)

      const plugin = cordova.plugins.browsertab

      plugin.isAvailable(
        isAvailable => resolve(isAvailable ? plugin : undefined),
        reject)
    })
  }

  private initCordovaCallbackIfNecessary() {
    if (!window.cordova) return
    if (window.handleOpenURL) return

    window.handleOpenURL = url => {
      const cordova = window.cordova
      if (!cordova) return

      const parsed = this.urlParser.checkUrlFragment(url)

      if (parsed && cordova.plugins && cordova.plugins.browsertab) {
        cordova.plugins.browsertab.close()
      }
    }
  }

  private loginWithPopup(opts: AuthOptions & { provider: ProviderId }): Promise<void> {
    type WinChanResponse<D> = { success: true, data: D } | { success: false, data: ErrorResponse }

    WinChan.open({
      url: `${this.authorizeUrl}?${toQueryString(opts)}`,
      relay_url: this.popupRelayUrl,
      window_features: this.computeProviderPopupOptions(opts.provider)
    }, (err: string, result: WinChanResponse<object>) => {
      if (err) {
        logError(err)
        this.eventManager.fireEvent('authentication_failed', {
          errorDescription: 'Unexpected error occurred',
          error: 'server_error'
        })
        return
      }

      const r = camelCaseProperties(result) as WinChanResponse<AuthResult>

      if (r.success) {
        this.authenticatedHandler(opts, r.data)
      } else {
        this.eventManager.fireEvent('authentication_failed', r.data)
      }
    })
    return Promise.resolve()
  }

  loginWithPassword(params: LoginWithPasswordParams) {
    const resultPromise = window.cordova
      ? this.loginWithPasswordByOAuth(params)
      : this.loginWithPasswordByRedirect(params)

    return resultPromise.catch((err: any) => {
      if (err.error) {
        this.eventManager.fireEvent('login_failed', err)
      }
      throw err
    })
  }

  private loginWithPasswordByOAuth({ email, password, auth }: LoginWithPasswordParams) {
    return this.requestPost<AuthResult>(this.tokenUrl, {
      clientId: this.config.clientId,
      grantType: 'password',
      username: email,
      password,
      scope: resolveScope(auth),
      ...(pick(auth, 'origin'))
    }).then(result => this.eventManager.fireEvent('authenticated', result))
  }

  private loginWithPasswordByRedirect({ auth = {}, ...rest }: LoginWithPasswordParams) {
    return this.requestPost<{ tkn: string }>('/password/login', {
      clientId: this.config.clientId,
      ...rest
    }).then(
      ({ tkn }) => this.loginWithPasswordToken(tkn, auth)
    )
  }

  private loginWithPasswordToken(tkn: string, auth: AuthOptions = {}) {
    const authParams = this.authParams(auth)

    const queryString = toQueryString({
      ...authParams,
      tkn
    })
    window.location.assign(`${this.baseUrl}/password/callback?${queryString}`)
  }

  startPasswordless(params: PasswordlessParams, opts: AuthOptions = {}) {
    const { authType, email, phoneNumber } = params

    return this.requestPost('/passwordless/start', {
      ...this.authParams(opts),
      authType,
      email,
      phoneNumber
    })
  }

  private loginWithVerificationCode(params: PasswordlessParams, auth: AuthOptions) {
    const queryString = toQueryString({
      ...this.authParams(auth),
      ...params
    })
    window.location.assign(`${this.baseUrl}/passwordless/verify?${queryString}`)
  }

  verifyPasswordless(params: PasswordlessParams, auth = {}) {
    return this.requestPost('/verify-auth-code', params).then(_ =>
      this.loginWithVerificationCode(params, auth)
    ).catch(err => {
      if (err.error) this.eventManager.fireEvent('login_failed', err)
      throw err
    })
  }

  signup(params: SignupParams) {
    const { data, auth } = params
    const acceptTos = auth && auth.acceptTos

    const result = window.cordova
      ? (
        this.requestPost<AuthResult>(`${this.baseUrl}/signup-token`, {
          clientId: this.config.clientId,
          scope: resolveScope(auth),
          ...(pick(auth, 'origin')),
          data
        }).then(result => this.eventManager.fireEvent('authenticated', result))
      )
      : (
        this.requestPost<{ tkn: string }>('/signup', { clientId: this.config.clientId, acceptTos, data })
          .then(({ tkn }) => this.loginWithPasswordToken(tkn, auth))
      )

    return result.catch(err => {
      if (err.error) {
        this.eventManager.fireEvent('signup_failed', err)
      }
      throw err
    })
  }

  requestPasswordReset({ email }: { email: string }) {
    return this.requestPost('/forgot-password', {
      clientId: this.config.clientId,
      email
    })
  }

  updatePassword(params: { accessToken?: string, password: string, oldPasssord?: string, userId?: string }) {
    const { accessToken, ...data } = params
    return this.requestPost(
      '/update-password',
      { clientId: this.config.clientId, ...data },
      { accessToken }
    )
  }

  updateEmail(params: { accessToken: string, email: string }) {
    const { accessToken, ...data } = params
    return this.requestPost('/update-email', data, { accessToken })
  }

  updatePhoneNumber(params: { accessToken: string, phoneNumber: string }) {
    const { accessToken, ...data } = params
    return this.requestPost('/update-phone-number', data, { accessToken })
  }

  verifyPhoneNumber({ accessToken, ...data }: { accessToken: string, phoneNumber: string, verificationCode: string }) {
    const { phoneNumber } = data
    return this.requestPost('/verify-phone-number', data, { accessToken })
      .then(() =>
        this.eventManager.fireEvent('profile_updated', { phoneNumber, phoneNumberVerified: true })
      )
  }

  unlink({ accessToken, ...data }: { accessToken: string, identityId: string, fields?: string }) {
    return this.requestPost('/unlink', data, { accessToken })
  }

  refreshTokens({ accessToken }: { accessToken: string }) {
    return this.request<AuthResult>('/token/access-token', {
      method: 'POST',
      body: {
        clientId: this.config.clientId,
        accessToken
      }
    }).then(enrichAuthResult)
  }

  getUser({ accessToken, ...params }: { accessToken: string, fields?: string }) {
    return this.requestGet('/me', params, { accessToken })
  }

  updateProfile({ accessToken, data }: { accessToken: string, data: Profile }) {
    return this.requestPost(
      '/update-profile',
      data,
      { accessToken }
    ).then(() => this.eventManager.fireEvent('profile_updated', data))
  }

  loginWithCustomToken({ token, auth }: { token: string, auth: AuthOptions }) {
    const queryString = toQueryString({
      ...this.authParams(auth),
      token
    })
    window.location.assign(`${this.baseUrl}/custom-token/login?${queryString}`)
  }

  getSsoData(auth = {}) {
    const hints = pick(auth, ['idTokenHint', 'loginHint'])
    return this.requestGet(
      '/sso/data',
      { clientId: this.config.clientId, ...hints },
      { withCookies: true }
    )
  }

  private authenticatedHandler = ({ responseType, redirectUri }: AuthOptions, response: AuthResult) => {
    if (responseType === 'code') {
      window.location.assign(`${redirectUri}?code=${response.code}`)
    } else {
      this.eventManager.fireEvent('authenticated', response)
    }
  }

  private requestGet(path: string, params: {} = {}, options: Omit<RequestParams, 'params'>) {
    return this.request(path, { params, ...options })
  }

  private requestPost<Data>(path: string, body: {}, options = {}, params = {}) {
    return this.request<Data>(path, { method: 'POST', params, body, ...options })
  }

  private request<Data>(path: string, requestParams: RequestParams): Promise<Data> {
    const { method = 'GET', params = {}, body, accessToken = null, withCookies = false } = requestParams

    const fullPath = params && !isEmpty(params)
      ? `${path}?${toQueryString(params)}`
      : path

    const url = fullPath.startsWith('http') ? fullPath : this.baseUrl + fullPath

    const fetchOptions: RequestInit = {
      method,
      headers: {
        ...(accessToken && { 'Authorization': 'Bearer ' + accessToken }),
        ...(this.config.language && { 'Accept-Language': this.config.language }),
        ...(body && { 'Content-Type': 'application/json;charset=UTF-8' })
      },
      ...(withCookies && this.config.sso && { credentials: 'include' }),
      ...(body && { body: JSON.stringify(snakeCaseProperties(body)) })
    }

    return ajax<Data>({ url, ...fetchOptions })
  }

  private computeProviderPopupOptions(provider: ProviderId) {
    try {
      const windowOptions = (provider && providerSizes[provider]) || {
        width: 400,
        height: 550
      }
      const left = Math.max(0, (screen.width - windowOptions.width) / 2)
      const top = Math.max(0, (screen.height - windowOptions.height) / 2)
      const width = Math.min(screen.width, windowOptions.width)
      const height = Math.min(screen.height, windowOptions.height)
      return `menubar=0,toolbar=0,resizable=1,scrollbars=1,width=${width},height=${height},top=${top},left=${left}`
    } catch (e) {
      return 'menubar=0,toolbar=0,resizable=1,scrollbars=1,width=960,height=680'
    }
  }

  private authParams(opts: AuthOptions, { acceptPopupMode = false } = {}) {
    return {
      clientId: this.config.clientId,
      ...prepareAuthOptions(opts, { acceptPopupMode })
    }
  }
}