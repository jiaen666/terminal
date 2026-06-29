#define _GNU_SOURCE
#include <stdio.h>
#include <dlfcn.h>
#include <openssl/ssl.h>
#include <openssl/x509_vfy.h>
#include <openssl/x509.h>

// Hook SSL_set_verify -> disable verification
typedef void (*setv_t)(SSL*,int,int(*)(int,X509_STORE_CTX*));
void SSL_set_verify(SSL*s,int m,int(*c)(int,X509_STORE_CTX*))
{static setv_t f;if(!f)f=(setv_t)dlsym(RTLD_NEXT,"SSL_set_verify");f(s,SSL_VERIFY_NONE,NULL);}

// Hook SSL_CTX_set_verify -> disable verification
typedef void (*ctxv_t)(SSL_CTX*,int,int(*)(int,X509_STORE_CTX*));
void SSL_CTX_set_verify(SSL_CTX*x,int m,int(*c)(int,X509_STORE_CTX*))
{static ctxv_t f;if(!f)f=(ctxv_t)dlsym(RTLD_NEXT,"SSL_CTX_set_verify");f(x,SSL_VERIFY_NONE,NULL);}

// Hook X509_verify_cert -> always return success (1)
typedef int (*x509v_t)(X509_STORE_CTX*);
int X509_verify_cert(X509_STORE_CTX*ctx)
{static x509v_t f;if(!f)f=(x509v_t)dlsym(RTLD_NEXT,"X509_verify_cert");
 int ret=f(ctx);
 if(ret<=0){
  X509_STORE_CTX_set_error(ctx, X509_V_OK);
  ret=1;
 }
 return ret;}

// Hook SSL_get_verify_result -> always return X509_V_OK
typedef long (*sgvr_t)(const SSL*);
long SSL_get_verify_result(const SSL*ssl)
{static sgvr_t f;if(!f)f=(sgvr_t)dlsym(RTLD_NEXT,"SSL_get_verify_result");
 long ret=f(ssl);
 if(ret!=X509_V_OK) return X509_V_OK;
 return ret;}
