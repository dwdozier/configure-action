//
// Copyright (C) 2021 CloudTruth, Inc.
//

import * as core from '@actions/core'
import {Api} from './gen/Api'
import {LIB_VERSION} from './version'
import {validate as uuidValidate} from 'uuid'
import {PaginatedParameterList, Project, ProjectsParametersListParams} from './gen/data-contracts'
import {HttpResponse} from './gen/http-client'
import fetch from 'isomorphic-fetch'

const USER_AGENT = `configure-action/${LIB_VERSION}`

export async function fetchWithRetry(
  url: RequestInfo,
  {headers, ...options}: RequestInit = {},
  init?: RequestInit,
  {timeoutInSeconds, tries} = {timeoutInSeconds: 10, tries: 1}
): Promise<Response> {
  let response: Response
  let controller: AbortController

  core.info(`Fetching ${url} with ${timeoutInSeconds} seconds timeout and will try ${tries} time(s).`)
  for (let tryCount = 0; tryCount < tries; tryCount++) {
    core.info(`Try ${tryCount + 1} of ${tries}.`)
    let timeoutId

    try {
      controller = new AbortController()
      timeoutId = setTimeout(() => controller.abort(), timeoutInSeconds * 1000)
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          ...headers
        },
        ...init
      })

      clearTimeout(timeoutId)

      return response
    } catch (error: any) {
      core.info(`Caught error ${error}`)
      if (timeoutId) {
        clearTimeout(timeoutId)
      }

      if (!(error instanceof DOMException) || error.name !== 'AbortError') {
        throw error
      }
    }
  }

  throw new Error(`Failed to fetch ${url} after ${tries} tries.`)
}

export const configurefetch = (
  url: RequestInfo,
  /* istanbul ignore next */
  {headers, ...options}: RequestInit = {}
) => {
  return fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      ...headers
    },
    ...options
  })
}

type SecurityDataType = {apikey: string}

export function api(): Api<SecurityDataType> {
  const api = new Api<SecurityDataType>({
    baseUrl: core.getInput('server') || 'https://api.cloudtruth.io',
    customFetch: fetchWithRetry as any,
    securityWorker: (securityData: SecurityDataType | null) => {
      return {
        headers: {
          ['Authorization']: 'Api-Key ' + securityData!.apikey
        },
        keepalive: true
      }
    }
  })
  api.setSecurityData({apikey: core.getInput('apikey')})
  core.debug(`Using API server ${JSON.stringify(api)}`)
  return api
}

function inject(response: HttpResponse<PaginatedParameterList>): void {
  const overwrite = core.getInput('overwrite') || false
  for (const entry of response.data.results!) {
    const values = Object.values(entry.values)
    const valueRecord = values[0]!
    const effectiveValue = valueRecord?.value
    const isSecret = entry.secret
    const parameterName = entry.name

    core.info(`I'm alive`)

    if (effectiveValue != null) {
      if (parameterName in process.env && !overwrite) {
        throw new Error(`The environment variable "${parameterName}" already exists and cannot be overwritten.`)
      }

      if (isSecret) {
        core.info(`Declaring "${parameterName}" as a secret.`)
        core.setSecret(effectiveValue)
      }

      core.info(`Setting environment variable "${parameterName}"`)
      core.exportVariable(parameterName, effectiveValue)
    } else {
      core.warning(`Ignoring unset value for parameter "${parameterName}" (GitHub Actions does not support unsetting).`)
    }
  }
}

async function resolve_project_id(project_name_or_id: string, api: Api<SecurityDataType>): Promise<string> {
  if (uuidValidate(project_name_or_id)) {
    // we look it up to make sure the id is good and we have permission to use it
    try {
      const response = await api.projectsRetrieve(project_name_or_id)
      return response.data.id
    } catch (error: HttpResponse<Project, any> | any) {
      throw new Error(`Project "${project_name_or_id}": ${error.error.detail}`)
    }
  }

  const response = await api.projectsList({name: project_name_or_id})
  if (response.data.count == 1) {
    const result = response.data.results!
    return result[0].id
  }
  throw new Error(`Project "${project_name_or_id}": Not found.`)
}

export async function run(): Promise<void> {
  try {
    const client = api()
    const project_id = await resolve_project_id(core.getInput('project', {required: true}), client)
    const environment = core.getInput('environment', {required: true})
    const tag = core.getInput('tag') || undefined

    for (let page = 1; ; ++page) {
      let page_size = undefined
      if (process.env.TESTING_REST_API_PAGE_SIZE) {
        page_size = parseInt(process.env.TESTING_REST_API_PAGE_SIZE)
      }

      const payload = {
        projectPk: project_id,
        environment: environment,
        page: page,
        page_size: page_size
      } as ProjectsParametersListParams

      if (tag) {
        payload.tag = tag
        core.info(
          `Requesting parameter values for project='${project_id}' environment='${environment}' tag='${tag}' page=${page}`
        )
      } else {
        core.info(`Requesting parameter values for project='${project_id}' environment='${environment}' page=${page}`)
      }

      core.info(`Payload ${JSON.stringify(payload)}`)
      const response = await client.projectsParametersList(payload)
      core.info(`Received ${response.data.results!.length} parameters.`)
      core.info(`Data: ${JSON.stringify(response.data)}`)

      inject(response)
      if (response.data.next == null) {
        if (page == 1 && response.data.count == 0) {
          core.warning(`Project ${core.getInput('project')} has no parameters.`)
        }
        break
      }
    }
  } catch (error: any) {
    core.setFailed(error.message || error.error.detail)
  }
}
