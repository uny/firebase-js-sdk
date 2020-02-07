/**
 * @license
 * Copyright 2019 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { AuthProvider, ProviderId, SignInMethod } from '../providers';
import { AuthCredential } from '../strategies/auth_credential';

export class EmailAuthCredential implements AuthCredential {
  constructor(readonly email: string, readonly password: string, readonly providerId: typeof EmailAuthProvider.PROVIDER_ID, readonly signInMethod: SignInMethod) {}
  toJSON(): object {
    return {
      email: this.email,
      password: this.password,
      providerId: this.providerId,
      signInMethod: this.signInMethod
    };
  }
}

export class EmailAuthProvider implements AuthProvider {
  static readonly PROVIDER_ID = ProviderId.PASSWORD;
  static readonly EMAIL_PASSWORD_SIGN_IN_METHOD = SignInMethod.EMAIL_PASSWORD;
  static readonly EMAIL_LINK_SIGN_IN_METHOD = SignInMethod.EMAIL_LINK;
  readonly providerId: ProviderId = EmailAuthProvider.PROVIDER_ID;
  static credential(email: string, password: string, signInMethod: SignInMethod): EmailAuthCredential {
    return new EmailAuthCredential(
      email,
      password,
      EmailAuthProvider.PROVIDER_ID,
      signInMethod
    );
  }
}
