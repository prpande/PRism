using PRism.Core;
using Xunit;

namespace PRism.Core.Tests;

public class ReviewThreadResultTests
{
    [Fact]
    public void Ok_is_success_with_none()
    {
        Assert.True(ReviewThreadResult.Ok.Success);
        Assert.Equal(ReviewThreadErrorCode.None, ReviewThreadResult.Ok.ErrorCode);
    }

    [Fact]
    public void Fail_carries_the_code_and_is_not_success()
    {
        var r = ReviewThreadResult.Fail(ReviewThreadErrorCode.TokenCannotWrite);
        Assert.False(r.Success);
        Assert.Equal(ReviewThreadErrorCode.TokenCannotWrite, r.ErrorCode);
    }
}
